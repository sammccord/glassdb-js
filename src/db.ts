export const nameRegexp = new RegExp(/^[a-zA-Z0-9]+$/)

export interface Options {
  clock: Date
  logger: Logger
  cacheSize: number
}

export function defaultOptions(): Options {
  return {
    clock: new Date(),
    logger: new Logger(),
    cacheSize: 5012 * 1024 * 1024
  }
}

export function open(ctx: Context, name: string, backend: Backend): DB {
  return openWith(ctx, name, defaultOptions())
}

export function openWith(ctx: Context, name: string, backend: Backend, options: Options): DB {
  if (!nameRegexp.test(name)) {
    throw new Error(`name must be alphanumeric, got ${name}`)
  }
  checkOrCreateDBMeta(ctx, backend, name)
  const cache = new Cache(options.cacheSize)
  const bg = new Background()
  const backend = new StatsBackend(backend)
  const local = new LocalStorage(cache, options.clock)
  const global = new GlobalStorage(backend, local, options.clock)
  const tl = new TLogger(options.clock, global, local, name)
  const tmon = new Monitor(options.clock, local, tl, bg)
  const locker = new Locker(local, global, tf, options.clock, tmon)
  const gc = new GC(options.clock, bg, tl, options.logger)
  gc.start(ctx)
  const ta = new Algo(opts.Clock, global, local, locker, tmon, gc, bg, opts.Logger)
  const res = new DB({
    name,
    backend,
    cache,
    background: bg,
    tmon,
    gc,
    algo: ta,
    clock: options.clock,
    logger: options.logger
  })

  res.root = res.openCollection(name)
  return res
}

interface DBOptions {
  name: string,
  backend: StatsBackend,
  cache: Cache,
  background: Background,
  tmon: Monitor
  gc: GC,
  algo: Algo,
  clock: Date,
  logger: Logger
}

class DB {
  name: string,
  backend: StatsBackend,
  cache: Cache,
  background: Background,
  tmon: Monitor
  gc: GC,
  algo: Algo,
  clock: Date,
  logger: Logger
  root: Collection | undefined
  stats: Stats | undefined
  statsM: SharedArrayBuffer | undefined

  constructor(options: DBOptions) {
    this.name = options.name
    this.backend = options.backend
    this.cache = options.cache
    this.background = options.background
    this.tmon = options.tmon
    this.gc = options.gc
    this.algo = options.algo
    this.clock = options.clock
    this.logger = options.logger
  }

  public close(ctx: Context) {
    this.background.close()
  }

  public collection(name: string): Collection {
    const p = fromCollection(this.root.prefix, name)
    return this.openCollection(p)
  }

  public tx(ctx: Context, func: (tx: Tx) => void) {
    const stats = new Stats({ TxN: 1 })
    const begin = Date.now()
    const [ctx, task] = new Task(ctx, "tx")
    this.txImpl(ctx, func, stats)
    task.end()
    stats.txTime = Date.now() - begin
    this.updateStats(stats)
  }

  public stats(): Stats {
    //TODO figure out locking
    this.statsM.lock()
    const bstats = this.backend.statsAndReset()
    this.stats.add(bstats)
    this.statsM.unlock()
    return this.stats
  }

  public openCollection(prefix: string): Collection {
    const local = new LocalStorage(this.cache, this.clock)
    const global = new GlobalStorage(this.backend, local, this.clock)
    return new Collection(prefix, global, local, this.algo, this)
  }

  public txImpl(ctx: Context, func: ((tx: Tx) => Promise<void>), stats: Stats) {
    const local = new LocalStorage(this.cache, this.clock)
    const global = new GlobalStorage(this.backend, local, this.clock)
    const tx = new Tx(ctx, global, local, this.tmon)
    let handle: Handle
    let err: Error

    while(!err) {
      ctx.Err()
      let fnErr: Error
      try {
        await Trace.WithRegion(ctx, "user-tx", async () => {
          await func(tx)
        })
      } catch(e) {
        fnErr = e
      } finally {
        if(tx.aborted) throw new AbortedError()
      }
      const access = tx.collectAccesses()
      stats.txReads += access.reads.length
      stats.txWrites += access.writes.length
      if(!handle) {
        handle = this.algo.begin(ctx, access)
      } else {
        this.algo.reset(handle, access)
      }

      if(fnErr) {
        access.writes = undefined
        this.algo.reset(handle, access)
        try {
          this.algo.validateReads(ctx, handle)
        } catch(e) {
          if(e instanceof RetryError) {
            tx.reset()
            stats.txRetries++
            continue
          }
        } finally {
          throw fnErr
        }
      }


      await Trace.WithRegion(ctx, "commit", async () => {
        try {
          await this.algo.commit(ctx, handle)
        } catch(e) {
          err = e
        }
      })
      if(err) {
        if(err instanceof RetryError) {
          tx.reset()
          stats.txRetries++
          continue
        }
        throw err
      }
      break
    }
  }

  public updateStats(s: Stats) {
    //TODO figure out lock?
    this.stats.add(s)
    //TODO figure out lock?
  }
}
