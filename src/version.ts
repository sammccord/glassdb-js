import path from 'node:path'
const dbVersion = 'v0'
const dbMetaPath = 'glassdb'
const dbVersionTag = 'version'

export async function checkOrCreateDBMeta(ctx: Context, b: Backend, name: string) {
  try {
    await checkDBVersion(ctx, b, name)
    return
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw e
    }
  }
  try {
    await setDBMetadata(ctx, b, name, dbVersion)
    return
  } catch (e) {
    if (e instanceof PreconditionError) {
      throw e
    }
  }
  return checkDBVersion(ctx, b, name)
}

export async function checkDBVersion(ctx: Context, b: Backend, name: string) {
  const p = path.join(name, dbMetaPath)
  const meta = await b.getMetadata(ctx, p)
  const v = meta.tags[dbVersionTag]
  if (v !== dbVersion) {
    throw new Error(`got db version ${v}, expected ${dbVersion}`)
  }
}

export async function setDBMetadata(ctx: Context, b: Backend, name: string, version: string) {
  const p = path.join(name, dbMetaPath)
  await b.writeIfNotExists(ctx, p, undefined, new Tags({ dbVersionTag: version }))
}
