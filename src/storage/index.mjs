import { createPolicyStore } from './policy-store.mjs'
import { createQueueStore } from './queue-store.mjs'
import { createSettingsStore } from './settings-store.mjs'
import { createHostLogger } from './host-log.mjs'
import { createCnyBookStore } from './cny-book-store.mjs'

export function createPriceFlowStores(root) {
  return {
    policy: createPolicyStore(root),
    queue: createQueueStore(root),
    settings: createSettingsStore(root),
    logger: createHostLogger(root),
    cnyBook: createCnyBookStore(root),
  }
}
