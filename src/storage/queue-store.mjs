import { createAtomicJsonStore } from './atomic-json.mjs'
import { emptyQueueState, migrateQueueState, QUEUE_SCHEMA_VERSION, validateQueueState } from '../queue/state-machine.mjs'

export function createQueueStore(root, { requestId } = {}) {
  const file = `${root.replace(/[\\/]$/, '')}/queue.json`
  const store = createAtomicJsonStore(file, { validate: validateQueueState })
  async function migrateAndPersist(value) {
    if (value == null) return null
    const validated = validateQueueState(value)
    if (validated.schemaVersion === QUEUE_SCHEMA_VERSION) return validated
    const migrated = migrateQueueState(validated, requestId)
    await store.write(migrated)
    return migrated
  }
  return {
    path: file,
    async load() { return migrateAndPersist(await store.read()) },
    async save(state) {
      const validated = validateQueueState(state)
      if (validated.schemaVersion !== QUEUE_SCHEMA_VERSION) throw new TypeError('legacy queue state must be migrated before save')
      return store.write(validated)
    },
    async update(mutator) {
      return store.update((current) => {
        const migrated = current == null ? emptyQueueState() : migrateQueueState(current, requestId)
        return validateQueueState(mutator(migrated))
      })
    },
  }
}
