# Task 1: LID/JID Helpers - Learnings

## Codebase Understanding

### Key Patterns Found
1. **JID Mapping**: `jid_mapping` table stores `lid_jid` → `phone_jid` pairs
2. **getAllJidsFor()**: Already exists (lines 328-338), expands one JID to all variants
3. **getChats() merge logic**: Lines 397-428 show the inline Map-based merge pattern we need to extract
4. **Test seed pattern**: `seedTestDb()` in test-db.ts uses `db.prepare().run()` directly

### Implementation Plan
- [ ] Add `getCanonicalJid(jid)` - resolves LID→phone when mapping exists
- [ ] Add `getActiveJid(jid)` - returns JID with most recent message activity
- [ ] Add `mergeByCanonicalJid<T>()` - generic dedup helper
- [ ] Refactor `getChats()` to use `mergeByCanonicalJid`
- [ ] Add `seedLidTestData()` to test-db.ts
- [ ] Write tests in lid-helpers.test.ts

### Test Data Structure
- Mapped pair: `169509591765046@lid` ↔ `50763345671@s.whatsapp.net` (Panama Equity)
- Unmapped LID: `999999999@lid` (Unknown Broker)
- Messages under both JIDs for the mapped pair
