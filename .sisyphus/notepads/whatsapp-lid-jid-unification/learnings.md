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

## Task 1 Completion

### What Was Implemented
1. ✅ `getCanonicalJid(jid)` - resolves LID→phone when mapping exists, else returns input
2. ✅ `getActiveJid(jid)` - returns JID with most recent message activity
3. ✅ `mergeByCanonicalJid<T>()` - generic dedup helper using Map keyed by canonical JID
4. ✅ Refactored `getChats()` to use `mergeByCanonicalJid` instead of inline Map logic
5. ✅ `seedLidTestData()` in test-db.ts - creates test data with:
   - Mapped pair: `169509591765046@lid` ↔ `50763345671@s.whatsapp.net` (Panama Equity)
   - Unmapped LID: `999999999@lid` (Unknown Broker)
   - Messages under both JIDs for the mapped pair
6. ✅ Tests in lid-helpers.test.ts - 11 tests covering all helpers

### Test Results
- All 11 new tests pass
- All 134 existing tests pass (no regressions)
- TypeScript: 0 errors

### Key Implementation Details
- `getCanonicalJid`: Simple check for @lid suffix, calls `getPhoneJid()` if found
- `getActiveJid`: Uses `getAllJidsFor()` to get variants, queries for max timestamp
- `mergeByCanonicalJid`: Generic function using Map with canonical JID as key
- `getChats()` refactor: Replaced 20 lines of inline merge logic with single call to `mergeByCanonicalJid`
- Test seed: Uses same pattern as `seedTestDb()` with direct `db.prepare().run()` calls

### Files Modified
- src/db.ts: Added 3 helpers, refactored getChats()
- src/__tests__/helpers/test-db.ts: Added seedLidTestData()
- src/__tests__/lid-helpers.test.ts: New test file with 11 tests
