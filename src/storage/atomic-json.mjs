import { open, readFile, rename, rm, mkdir, copyFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class AtomicJsonError extends Error {
  constructor(message, code = 'storage-error', cause) { super(message, { cause }); this.name = 'AtomicJsonError'; this.code = code }
}

export function createAtomicJsonStore(path, { validate = (value) => value, backup = true } = {}) {
  let serial = Promise.resolve()
  const backupPath = `${path}.bak`
  const enqueue = (operation) => {
    const current = serial.then(operation, operation)
    serial = current.catch(() => {})
    return current
  }
  async function writeUnlocked(value) {
    const normalized = validate(value)
    const directory = dirname(path)
    await mkdir(directory, { recursive: true })
    const temp = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    const json = `${JSON.stringify(normalized, null, 2)}\n`
    let handle
    try {
      handle = await open(temp, 'wx')
      await handle.writeFile(json, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      if (backup) {
        let mainBytes = null
        try { mainBytes = await readFile(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (mainBytes !== null) {
          let mainIsValid = false
          try { validate(JSON.parse(mainBytes.toString('utf8'))); mainIsValid = true } catch { /* retain prior backup during recovery */ }
          if (mainIsValid) await copyFile(path, backupPath)
        }
      }
      try {
        await rename(temp, path)
      } catch (error) {
        // Windows rename does not replace an existing destination. Move the old
        // target aside, then replace; restore it if the replacement fails.
        if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
        const displaced = `${path}.${randomUUID()}.old`
        let hadTarget = false
        try { await rename(path, displaced); hadTarget = true } catch (moveError) { if (moveError?.code !== 'ENOENT') throw moveError }
        try {
          await rename(temp, path)
          if (hadTarget) await rm(displaced, { force: true })
        } catch (replaceError) {
          if (hadTarget) {
            try { await rename(displaced, path) } catch { /* preserve replacement error; backup remains */ }
          }
          throw replaceError
        }
      }
      try {
        const dirHandle = await open(directory, 'r')
        try { await dirHandle.sync() } finally { await dirHandle.close() }
      } catch { /* directory fsync is unsupported on some Windows filesystems */ }
      return normalized
    } catch (error) {
      try { await handle?.close() } catch { /* ignore cleanup errors */ }
      try { await rm(temp, { force: true }) } catch { /* ignore cleanup errors */ }
      throw new AtomicJsonError(`failed to atomically write ${path}: ${error.message}`, 'write-failed', error)
    }
  }
  async function readCandidate(candidate) {
    const text = await readFile(candidate, 'utf8')
    return validate(JSON.parse(text))
  }
  async function readRecovering() {
    try { return await readCandidate(path) } catch (mainError) {
      if (mainError?.code === 'ENOENT') {
        try { return await readCandidate(backupPath) } catch (backupError) {
          if (backupError?.code === 'ENOENT') return null
          throw new AtomicJsonError(`main and backup JSON are invalid for ${path}`, 'corrupt-main-and-backup', backupError)
        }
      }
      try { return await readCandidate(backupPath) } catch (backupError) {
        throw new AtomicJsonError(`main and backup JSON are invalid for ${path}`, 'corrupt-main-and-backup', backupError)
      }
    }
  }
  return {
    path,
    backupPath,
    read() {
      return enqueue(async () => {
        return readRecovering()
      })
    },
    write(value) { return enqueue(() => writeUnlocked(value)) },
    update(mutator) {
      if (typeof mutator !== 'function') throw new TypeError('mutator must be a function')
      return enqueue(async () => {
        const current = await readRecovering()
        const next = await mutator(current)
        return writeUnlocked(next)
      })
    },
  }
}
