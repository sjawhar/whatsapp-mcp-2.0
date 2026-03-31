# WhatsApp MCP: LID/JID Unification

## TL;DR

> **Quick Summary**: Fix the WhatsApp MCP so agents never deal with JID vs LID confusion. One person = one identity. Merge conversations, canonicalize outputs, route sends to the active thread.
> 
> **Deliverables**:
> - `getCanonicalJid()` and `getActiveJid()` shared helpers in db.ts
> - All read tools return canonical phone JID (when mapping exists)
> - `getUnreadChats()` merges LID/phone unreads
> - `searchContacts()` deduplicates LID/phone entries
> - Send path routes to active JID (LID or phone)
> - Delete operations work with either JID form
> - Auto-resolve contacts on startup + periodic 30-min refresh
> - Integration tests covering all LID/phone merge scenarios
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Task 1 → Tasks 2-5 (parallel) → Tasks 6-8 (parallel) → Task 9

---

## Context

### Original Request
Fix the WhatsApp MCP (`~/Code/whatsapp-mcp`) to eliminate the LID/JID confusion that causes agents to miss replies. One real person can appear under both a phone-number JID (`50763345671@s.whatsapp.net`) and a LID (`169509591765046@lid`). Agents checking only one miss messages on the other.

### Interview Summary
**Key Discussions**:
- **Unmapped LIDs**: Names matter, not phone numbers. Unmapped LID contacts with names appear normally — only merge when a mapping exists.
- **Groups**: 1:1 chats only. No group participant LID resolution.
- **Test strategy**: TDD with vitest integration tests (infra already exists) + manual QA against live WhatsApp session.
- **Backward compat**: Existing agents using phone JIDs must keep working.

**Codebase Analysis**:
- `db.getAllJidsFor(jid)` already exists and many read functions use it
- `db.getChats()` already has full LID merge logic (Map-based canonicalization)
- 9 specific gaps identified where LID/phone duality isn't handled
- Test infra: vitest + in-memory SQLite + fake Baileys socket + MCP test client helpers (24 existing tests)

### Metis Review
**Identified Gaps** (addressed):
- **Shared resolution path**: All functions MUST use the same `getAllJidsFor()` / `getCanonicalJid()` helpers — no ad-hoc resolution logic per function.
- **Canonical JID contract**: All read APIs return phone JID when available, for backward compatibility.
- **Delete semantics**: Use `getAllJidsFor()` to FIND records, but target the specific underlying JID for WhatsApp API calls. Clean up both variants from local DB.

---

## Work Objectives

### Core Objective
Make the WhatsApp MCP present a unified view where each real person has one identity, regardless of whether their messages arrive on a LID or phone-number JID.

### Concrete Deliverables
- `db.getCanonicalJid(jid)` — resolves LID→phone when mapping exists
- `db.getActiveJid(jid)` — returns the JID with most recent message activity (for send routing)
- Fixed `getUnreadChats()`, `searchContacts()`, `searchMessages()` (global), `getRecentMessages()`
- Fixed `sendTextMessage()` / `sendFileMessage()` to route to active JID
- Fixed `deleteMessage()` / `deleteChat()` to work with either JID form
- Fixed `resolveChatName()` and `getRecipientInfo()` for LID-aware name lookup
- Auto-resolve on startup + 30-minute refresh interval
- Updated tool descriptions
- Integration tests for all changes

### Definition of Done
- [ ] `vitest run` passes (all existing + new tests)
- [ ] `tsc --noEmit` passes (no type errors)
- [ ] Manual QA: `get_unread_messages` shows merged LID/phone unreads for known dual-identity contacts
- [ ] Manual QA: `search_contacts` for a known LID contact returns one entry with phone JID
- [ ] Manual QA: `send_message` to a contact with LID activity routes to the active JID

### Must Have
- All 9 gaps fixed (listed in "GAPS" section of draft)
- Backward compatibility: phone JIDs still work as input everywhere
- TDD: each fix has a corresponding integration test
- Auto-resolve on startup

### Must NOT Have (Guardrails)
- **No group chat LID resolution** — 1:1 only
- **No new tables or schema migrations** — use existing `jid_mapping` table
- **No ad-hoc resolution logic** — all functions use shared helpers (`getAllJidsFor`, `getCanonicalJid`, `getActiveJid`)
- **No changes to agents consuming the MCP** — transparency is the whole point
- **No renaming of existing MCP tools** — backward compatible
- **No removal of LID from DB storage** — messages stay under their original `chat_jid`, canonicalization is at the read/output layer only

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION in task acceptance** — individual task acceptance criteria are all agent-executable (vitest, bash, grep). No task requires a human to manually verify.
> The Final Verification Wave (F1-F4) runs review agents autonomously, then presents consolidated results to the user for approval/rejection. This user gate is an orchestrator-level concern, not a per-task requirement.

### Test Decision
- **Infrastructure exists**: YES (vitest, 24 test files, helpers)
- **Automated tests**: TDD — write test first, then implement
- **Framework**: vitest
- **Pattern**: Seed in-memory SQLite with LID↔phone paired data, call db/MCP functions, assert merged/canonical output

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **DB functions**: Use Bash (vitest) — run specific test file, assert pass
- **MCP tools**: Use Bash (vitest) — integration test via MCP test client helper
- **Manual QA**: Use WhatsApp MCP tools directly via MCP client (for end-to-end verification in Task 9)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — shared helpers + test seed):
└── Task 1: Add getCanonicalJid, getActiveJid, LID test seed [quick]

Wave 2 (Read Path — MAX PARALLEL, all depend on Task 1):
├── Task 2: Fix getUnreadChats() to merge LID/phone [quick]
├── Task 3: Fix searchContacts() to deduplicate [quick]
├── Task 4: Fix searchMessages()/getRecentMessages() to canonicalize [quick]
└── Task 5: Fix resolveChatName() + getRecipientInfo() [quick]

Wave 3 (Write Path + System — parallel, depend on Task 1):
├── Task 6: Fix send routing to active JID [unspecified-high]
├── Task 7: Fix delete operations for LID-awareness [unspecified-high]
└── Task 8: Auto-resolve on startup + periodic refresh [quick]

Wave 4 (Integration + Polish — depend on Waves 2-3):
└── Task 9: Update tool descriptions + E2E integration test [quick]

Wave FINAL (After ALL tasks — parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1    | —         | 2,3,4,5,6,7,8 |
| 2    | 1         | 9 |
| 3    | 1         | 9 |
| 4    | 1         | 9 |
| 5    | 1         | 9 |
| 6    | 1         | 9 |
| 7    | 1         | 9 |
| 8    | 1         | 9 |
| 9    | 2,3,4,5,6,7,8 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 1 task → `quick`
- **Wave 2**: 4 tasks → all `quick`
- **Wave 3**: 3 tasks: T6 `unspecified-high`, T7 `unspecified-high`, T8 `quick`
- **Wave 4**: 1 task → `quick`
- **FINAL**: 4 tasks → `oracle`, `unspecified-high`, `unspecified-high`, `deep`

---

## TODOs


- [x] 1. Add `getCanonicalJid()`, `getActiveJid()` helpers + LID test seed data

  **What to do**:
  - Add `getCanonicalJid(jid: string): string` to `src/db.ts`:
    - If `jid` ends with `@lid`, call `getPhoneJid(jid)`. Return the phone JID if found, else return input.
    - If `jid` ends with `@s.whatsapp.net`, return as-is.
    - If neither, return as-is.
  - Add `getActiveJid(jid: string): string` to `src/db.ts`:
    - Call `getAllJidsFor(jid)` to get all variants.
    - If only one JID, return it.
    - Query `SELECT chat_jid, MAX(timestamp) AS latest FROM messages WHERE chat_jid IN (?) GROUP BY chat_jid ORDER BY latest DESC LIMIT 1`. Return the one with the most recent message.
    - Fallback to input JID if no messages found.
  - Add `mergeByCanonicalJid(items, getJid, merge)` generic helper to `src/db.ts`:
    - Deduplicates a list by canonical JID using a Map keyed by `getCanonicalJid(getJid(item))`
    - When a key collision occurs, calls `merge(existing, incoming)` to combine
    - Extracts the pattern currently inlined in `getChats()` lines 397-428
  - Refactor `getChats()` to use the new `mergeByCanonicalJid` helper (verify existing tests still pass)
  - Add LID-aware seed data to `src/__tests__/helpers/test-db.ts`:
    - Add `seedLidTestData()` function that creates:
      - A JID mapping: `169509591765046@lid` → `50763345671@s.whatsapp.net`
      - Contact entries for both JIDs (name: `Panama Equity`)
      - Chat entries for both JIDs
      - Messages under the LID JID (incoming replies)
      - Messages under the phone JID (sent by user)
    - Also create an unmapped LID contact (`999999999@lid`, name: `Unknown Broker`) with no mapping
  - Write tests in `src/__tests__/lid-helpers.test.ts`:
    - `getCanonicalJid` with LID that has mapping returns phone JID
    - `getCanonicalJid` with LID that has NO mapping returns LID as-is
    - `getCanonicalJid` with phone JID returns phone JID unchanged
    - `getActiveJid` when most recent message is under LID returns LID
    - `getActiveJid` when most recent message is under phone returns phone
    - `getActiveJid` with unknown JID returns input JID
    - `mergeByCanonicalJid` merges two items with same canonical JID into one
    - `mergeByCanonicalJid` preserves unmapped LIDs separately
    - `mergeByCanonicalJid` handles empty input

  **Must NOT do**:
  - Don't modify the `jid_mapping` table schema
  - Don't change `getAllJidsFor()` behavior (it's already correct)
  - Don't add any group-chat logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (foundation task)
  - **Parallel Group**: Wave 1 (solo)
  - **Blocks**: Tasks 2, 3, 4, 5, 6, 7, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/db.ts:328-338` — `getAllJidsFor(jid)` — the existing multi-JID resolution pattern. `getCanonicalJid` is the inverse: instead of expanding to all, it collapses to one.
  - `src/db.ts:275-287` — `saveJidMapping`, `getPhoneJid`, `getLidJid` — the existing JID mapping functions that `getCanonicalJid` builds on.
  - `src/db.ts:397-428` — `getChats()` LID merge logic — reference for how canonicalization is already done inline. `getCanonicalJid` extracts this into a reusable helper.

  **Test References**:
  - `src/__tests__/helpers/test-db.ts` — existing test seed pattern. `seedLidTestData()` follows the same pattern as `seedTestDb()`.
  - `src/__tests__/integration/search-flow.test.ts:8-70` — example of seeding additional test data in `beforeAll`.

  **Acceptance Criteria**:
  - [ ] `getCanonicalJid` exported from `src/db.ts`
  - [ ] `getActiveJid` exported from `src/db.ts`
  - [ ] `mergeByCanonicalJid` exported from `src/db.ts`
  - [ ] `getChats()` refactored to use `mergeByCanonicalJid` (existing chat-navigation tests still pass)
  - [ ] `seedLidTestData` exported from `src/__tests__/helpers/test-db.ts`
  - [ ] `npx vitest run src/__tests__/lid-helpers.test.ts` passes (9+ tests)

  **QA Scenarios:**
  ```
  Scenario: Helper functions work correctly
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/lid-helpers.test.ts
      2. Check output for "6 passed" (or more)
    Expected Result: All tests pass, 0 failures
    Evidence: .sisyphus/evidence/task-1-helpers-pass.txt

  Scenario: Existing tests still pass
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run
      2. Check for 0 failures in output
    Expected Result: All existing tests pass, no regressions
    Evidence: .sisyphus/evidence/task-1-regression.txt
  ```

  **Commit**: YES
  - Message: `feat(db): add getCanonicalJid and getActiveJid helpers`
  - Files: `src/db.ts`, `src/__tests__/helpers/test-db.ts`, `src/__tests__/lid-helpers.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 2. Fix `getUnreadChats()` to merge LID/phone chats

  **What to do**:
  - TDD: Write test first in `src/__tests__/integration/unread-lid.test.ts`:
    - Seed LID test data (call `seedLidTestData()`)
    - Set `unread_count > 0` on BOTH the LID chat and the phone chat for the same contact
    - Call `getUnreadChats(5)` from db.ts
    - Assert: only ONE entry for the merged contact (not two)
    - Assert: `jid` is the canonical phone JID (`50763345671@s.whatsapp.net`)
    - Assert: `unreadCount` is the SUM of both chats' unread counts
    - Assert: `recentMessages` contains messages from BOTH JID threads, sorted by timestamp
    - Assert: the unmapped LID contact (`999999999@lid`) appears as its own entry (no merge)
  - Implement: Modify `getUnreadChats()` in `src/db.ts`:
    - After fetching unread chats, use `mergeByCanonicalJid()` (from Task 1) to merge entries
    - The merge function should: sum unread counts, keep the best name, take the latest conversation_ts
    - For the `recentMessages` of merged entries, call `getMessages()` with the canonical JID (which already queries both via `getAllJidsFor`)
    - Re-sort merged results by latest message timestamp

  **Must NOT do**:
  - Don't implement your own Map-based merge — use the shared `mergeByCanonicalJid` helper from Task 1
  - Don't change the return type or field names of `getUnreadChats()`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/db.ts:397-428` — `getChats()` LID merge logic — COPY THIS PATTERN. It uses a Map keyed by canonical JID, merging timestamps and unread counts.
  - `src/db.ts:302-322` — current `getUnreadChats()` implementation — this is what you're modifying.
  - `src/db.ts:328-338` — `getAllJidsFor()` — already used by `getMessages()` which is called inside `getUnreadChats()`.

  **Test References**:
  - `src/__tests__/integration/search-flow.test.ts` — example integration test pattern with DB seeding and MCP tool assertions.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/integration/unread-lid.test.ts` → PASS
  - [ ] Merged entry has `jid: "50763345671@s.whatsapp.net"` (phone, not LID)
  - [ ] Merged entry's `unreadCount` is the sum from both chats
  - [ ] Unmapped LID contact appears separately

  **QA Scenarios:**
  ```
  Scenario: Unread chats merge LID and phone JID for same contact
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/integration/unread-lid.test.ts
      2. Check for all tests passing
    Expected Result: All assertions pass — merged unread, canonical JID, summed counts
    Evidence: .sisyphus/evidence/task-2-unread-merge.txt

  Scenario: Unmapped LID stays separate (no false merge)
    Tool: Bash
    Steps:
      1. In the same test file, assert the unmapped LID (999999999@lid) appears as its own entry
    Expected Result: Unmapped contacts are not merged with anyone
    Evidence: .sisyphus/evidence/task-2-unmapped-separate.txt
  ```

  **Commit**: YES
  - Message: `fix(db): merge LID/phone chats in getUnreadChats`
  - Files: `src/db.ts`, `src/__tests__/integration/unread-lid.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 3. Fix `searchContacts()` to deduplicate LID/phone entries

  **What to do**:
  - TDD: Write test first in `src/__tests__/integration/search-contacts-lid.test.ts`:
    - Seed LID test data
    - Call `searchContacts("Panama Equity")` from db.ts
    - Assert: returns exactly ONE result (not two — one for LID, one for phone)
    - Assert: the returned `jid` is the canonical phone JID
    - Assert: searching by phone number (`50763345671`) also returns one result
    - Assert: searching for the unmapped LID contact returns it with its LID as jid
  - Implement: Modify `searchContacts()` in `src/db.ts`:
    - After the existing query, use `mergeByCanonicalJid()` to deduplicate
    - The merge function should: keep the entry with the best name (non-null preferred)
    - Ensure `phone` field uses `fromJid(canonicalJid)` for display

  **Must NOT do**:
  - Don't change the return shape (jid, name, phone, isGroup)
  - Don't filter out unmapped LID contacts — they should still appear

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 4, 5)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/db.ts:532-547` — current `searchContacts()` implementation — this is what you're modifying.
  - `src/db.ts:397-428` — `getChats()` Map-based dedup pattern — follow similar approach.

  **API/Type References**:
  - `src/db.ts:328` — `getCanonicalJid()` (added in Task 1) — use for JID normalization.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/integration/search-contacts-lid.test.ts` → PASS
  - [ ] Searching by name returns ONE result with phone JID
  - [ ] Searching by phone number returns ONE result
  - [ ] Unmapped LID contacts appear with their LID as jid

  **QA Scenarios:**
  ```
  Scenario: Contact dedup works for mapped LID
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/integration/search-contacts-lid.test.ts
    Expected Result: All dedup assertions pass
    Evidence: .sisyphus/evidence/task-3-contacts-dedup.txt

  Scenario: Unmapped LID contact appears normally
    Tool: Bash
    Steps:
      1. Same test file — assert "Unknown Broker" appears with LID jid
    Expected Result: Unmapped contacts not lost or merged incorrectly
    Evidence: .sisyphus/evidence/task-3-unmapped-contact.txt
  ```

  **Commit**: YES
  - Message: `fix(db): deduplicate LID/phone contacts in searchContacts`
  - Files: `src/db.ts`, `src/__tests__/integration/search-contacts-lid.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 4. Fix `searchMessages()` global + `getRecentMessages()` to canonicalize `chat_jid`

  **What to do**:
  - TDD: Write test in `src/__tests__/integration/search-messages-lid.test.ts`:
    - Seed LID test data
    - Add a message under the LID JID containing "apartment" text
    - Call `searchMessages("apartment")` (global, no jid param) from db.ts
    - Assert: the result's `chat` field is the canonical phone JID, NOT the LID
    - Call `getRecentMessages(10)` from db.ts
    - Assert: messages from the LID thread have `chat` field = canonical phone JID
    - Also test: `searchMessages("apartment", "50763345671@s.whatsapp.net")` (with jid) still works (already uses `getAllJidsFor`)
  - Implement: Modify both functions in `src/db.ts`:
    - In `searchMessages()` (global path, when no `jid` param): map each result's `r.chat_jid` through `getCanonicalJid()` before returning
    - In `getRecentMessages()`: same canonicalization on `r.chat_jid`
    - Both functions already have `return rows.map((r) => ({ ...formatMessageRow(r), chat: r.chat_jid }))` — change `chat: r.chat_jid` to `chat: getCanonicalJid(r.chat_jid)`
  - **Note**: `getRecentMessages()` is also called from `src/resources.ts` for MCP resource subscriptions. The canonicalization will flow through to resource responses automatically — this is correct behavior, not a side effect.

  **Must NOT do**:
  - Don't change the `searchMessages(query, jid)` path with a specific JID — it already works via `getAllJidsFor`
  - Don't modify `formatMessageRow` itself — canonicalization is at the caller level

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 5)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/db.ts:502-530` — current `searchMessages()` implementation. Focus on lines 526-530 where the return map happens.
  - `src/db.ts:484-500` — current `getRecentMessages()` implementation. Same pattern at lines 496-500.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/integration/search-messages-lid.test.ts` → PASS
  - [ ] Global search results show canonical phone JID, not LID
  - [ ] Recent messages show canonical phone JID for LID threads

  **QA Scenarios:**
  ```
  Scenario: Global search returns canonical JID for LID-thread messages
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/integration/search-messages-lid.test.ts
    Expected Result: All assertions pass — chat field is phone JID, not LID
    Evidence: .sisyphus/evidence/task-4-search-canonical.txt
  ```

  **Commit**: YES
  - Message: `fix(db): canonicalize chat_jid in searchMessages and getRecentMessages`
  - Files: `src/db.ts`, `src/__tests__/integration/search-messages-lid.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 5. Fix `resolveChatName()` + `getRecipientInfo()` for LID-aware name lookup

  **What to do**:
  - TDD: Write test in `src/__tests__/lid-name-resolution.test.ts`:
    - Seed LID test data where the phone JID has a name but the LID does NOT
    - Call `getRecipientInfo("169509591765046@lid")` (the LID) from whatsapp.ts
    - Assert: `name` is "Panama Equity" (resolved via LID→phone mapping)
    - Assert: `jid` is the canonical phone JID
    - Assert: `phone` is the formatted phone number
    - Test inverse: phone JID with name only on LID — name still resolves
  - Implement:
    - `getRecipientInfo()` in `src/whatsapp.ts` (line ~982): After `toJid()`, also try `getCanonicalJid()` and `getAllJidsFor()` to find the contact name. If `db.getContactName(normalJid)` returns null, check the other JID variant.
    - `resolveChatName()` in `src/whatsapp.ts` (line ~786): When looking up a non-group JID, also check the other identity via `getAllJidsFor()`. If no name found for input JID, try the mapped JID.

  **Must NOT do**:
  - Don't change `resolveChatName`'s group logic (groups are out of scope)
  - Don't change the return type of `getRecipientInfo`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 4)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/whatsapp.ts:982-987` — current `getRecipientInfo()` — only checks one JID for name.
  - `src/whatsapp.ts:786-814` — current `resolveChatName()` — checks groups and `@s.whatsapp.net` but not LID counterpart.
  - `src/db.ts:348-363` — `resolveDisplayName()` — another name resolution function that could benefit from LID awareness, but it's not called from tools directly, so lower priority.

  **API/Type References**:
  - `src/db.ts:328` — `getCanonicalJid()` (Task 1)
  - `src/db.ts:328-338` — `getAllJidsFor()` — use to get both JID variants for name lookup
  - `src/db.ts:647-650` — `getContactName()` — the underlying name lookup function

  **Test References**:
  - `src/__tests__/integration/chat-navigation.test.ts` — example of testing whatsapp.ts functions that need a mocked Baileys socket.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/lid-name-resolution.test.ts` → PASS
  - [ ] LID input resolves to correct name from phone JID's contact entry
  - [ ] `getRecipientInfo` returns canonical phone JID even when given LID

  **QA Scenarios:**
  ```
  Scenario: Name resolved via LID-to-phone mapping
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/lid-name-resolution.test.ts
    Expected Result: All assertions pass — names found cross-identity
    Evidence: .sisyphus/evidence/task-5-name-resolution.txt

  Scenario: getRecipientInfo returns canonical JID
    Tool: Bash
    Steps:
      1. Same test: verify getRecipientInfo(LID) returns phone JID
    Expected Result: jid field is phone JID, not LID
    Evidence: .sisyphus/evidence/task-5-recipient-canonical.txt
  ```

  **Commit**: YES
  - Message: `fix(whatsapp): LID-aware name resolution in resolveChatName and getRecipientInfo`
  - Files: `src/whatsapp.ts`, `src/__tests__/lid-name-resolution.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 6. Fix send routing to use active JID for LID contacts

  **What to do**:
  - TDD: Write test in `src/__tests__/lid-send-routing.test.ts`:
    - Seed LID test data where the most recent message is under the LID JID (timestamp higher than phone JID messages)
    - Mock the Baileys socket's `sendMessage` to capture the target JID
    - Call `sendTextMessage("50763345671@s.whatsapp.net", "Hello")` (input is phone JID)
    - Assert: the socket's `sendMessage` was called with the LID JID (because that's the active thread)
    - Test inverse: when most recent message is under phone JID, send to phone JID
    - Test: when no messages exist for either JID, default to the input JID
    - Test: response `to` field shows the actual routed JID (not the original input)
  - Implement:
    - In `sendTextMessage()` (`src/whatsapp.ts:990`): After `toJid(jid)`, call `getActiveJid(normalJid)` to get the active thread's JID. Use THAT for `sendMessageWithHealthCheck()`.
    - In `sendFileMessage()` (`src/whatsapp.ts:1017`): Same change.
    - In `sendMessageWithHealthCheck()` or the caller: ensure the `sendMessage` call uses the active JID.
    - The response `to` field should show the actual JID the message was sent to (the active JID), so agents see where the message went.

  **Must NOT do**:
  - Don't change `toJid()` behavior — it normalizes input, `getActiveJid()` picks the route
  - Don't change the return shape of `sendTextMessage` or `sendFileMessage`
  - Don't modify the preview path in `tools.ts` — the preview gets its JID from `getRecipientInfo()` which is updated in Task 5 to return the canonical JID. This task only changes the actual send path.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Send routing involves socket mocking, cross-JID resolution, and non-trivial test setup. Needs more reasoning capacity than a haiku-class model.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 8)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/whatsapp.ts:990-1015` — current `sendTextMessage()` implementation. Line 993 does `toJid(jid)`, line 1008 does `sendMessageWithHealthCheck(s, normalJid, ...)`. Change `normalJid` to `getActiveJid(normalJid)` in the send call.
  - `src/whatsapp.ts:1017-1055` — current `sendFileMessage()`. Same pattern at line 1033.

  **API/Type References**:
  - `src/db.ts` — `getActiveJid()` (Task 1) — returns JID with most recent message activity.

  **Test References**:
  - `src/__tests__/integration/send-message.test.ts` — existing send test pattern with mocked socket.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/lid-send-routing.test.ts` → PASS
  - [ ] When active thread is on LID, socket sends to LID
  - [ ] When active thread is on phone JID, socket sends to phone JID
  - [ ] When no messages exist, sends to input JID

  **QA Scenarios:**
  ```
  Scenario: Send routes to active thread's JID
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/lid-send-routing.test.ts
    Expected Result: All routing assertions pass
    Evidence: .sisyphus/evidence/task-6-send-routing.txt

  Scenario: Backward compat — unknown JID sends to input
    Tool: Bash
    Steps:
      1. Same test: verify unknown JID goes to input JID directly
    Expected Result: No routing change for unknown contacts
    Evidence: .sisyphus/evidence/task-6-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `fix(whatsapp): route sends to active JID for LID contacts`
  - Files: `src/whatsapp.ts`, `src/__tests__/lid-send-routing.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 7. Fix delete operations for LID-awareness

  **What to do**:
  - TDD: Write test in `src/__tests__/lid-delete.test.ts`:
    - Seed LID test data with messages under both JIDs
    - Test `deleteMessage("50763345671@s.whatsapp.net", messageIdUnderLid)` — message stored under LID JID but deleted via phone JID
    - Assert: message is found and deleted (both from WhatsApp and local DB)
    - Test `deleteChat("169509591765046@lid")` — chat deleted via LID input
    - Assert: both the LID and phone JID chat entries and messages are cleaned up from local DB
  - Implement:
    - `deleteMessage()` in `src/whatsapp.ts` (line ~956): Use `getAllJidsFor(normalJid)` to find which `chat_jid` actually holds the message. Use the actual `chat_jid` for the WhatsApp API call.
    - Also fix `db.getMessageFromMe()` (`src/db.ts:340`) which currently only checks one JID. Change to use `getAllJidsFor()` to find the message across both JID variants.
    - `deleteChat()` in `src/whatsapp.ts` (line ~914): After the WhatsApp `chatModify` call, clean up BOTH JID variants from local DB (delete messages and chat entries for all JIDs in `getAllJidsFor()`).
    - `db.getLastMessageKey()` (`src/db.ts:626`): Modify to check across all JID variants (currently only checks one JID).

  **Must NOT do**:
  - Don't delete both JID variants from WhatsApp servers — only delete the one that was requested. The local DB cleanup covers both.
  - Don't change the WhatsApp chatModify API call signature

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Delete operations involve WhatsApp API calls, cross-JID record lookup, and multi-table cleanup. Complex interaction testing.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6, 8)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/whatsapp.ts:956-980` — current `deleteMessage()`. Line 962 calls `getMessageFromMe` with single JID.
  - `src/whatsapp.ts:914-954` — current `deleteChat()`. Lines 919, 950-951 operate on single `normalJid`.
  - `src/db.ts:340-344` — current `getMessageFromMe()` — single JID query that needs `getAllJidsFor()`.
  - `src/db.ts:626-636` — current `getLastMessageKey()` — single JID query that needs `getAllJidsFor()`.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/lid-delete.test.ts` → PASS
  - [ ] Delete message by phone JID finds message under LID JID
  - [ ] Delete chat cleans up both JID variants from local DB

  **QA Scenarios:**
  ```
  Scenario: Delete message finds message across JID variants
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/lid-delete.test.ts
    Expected Result: All delete assertions pass
    Evidence: .sisyphus/evidence/task-7-delete-ops.txt

  Scenario: Delete chat cleans both JID variants locally
    Tool: Bash
    Steps:
      1. Same test file — verify both JID entries removed from chats and messages tables
    Expected Result: No orphaned records under either JID
    Evidence: .sisyphus/evidence/task-7-delete-cleanup.txt
  ```

  **Commit**: YES
  - Message: `fix(whatsapp): LID-aware delete operations`
  - Files: `src/whatsapp.ts`, `src/db.ts`, `src/__tests__/lid-delete.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 8. Auto-resolve contacts on startup + periodic 30-minute refresh

  **What to do**:
  - TDD: Write test in `src/__tests__/lid-auto-resolve.test.ts`:
    - Mock the Baileys socket with `signalRepository.lidMapping.getPNForLID()` that returns known mappings
    - Verify that `initWhatsApp()` triggers `resolveUnknownContacts(false)` after connection is established
    - Verify that a 30-minute interval is set up (check `setInterval` is called)
    - Verify that the interval is cleared on `closeWhatsApp()`
    - Verify that concurrent calls are guarded (second call while first is running should be a no-op)
  - Implement:
    - Add a module-level `let resolveInProgress = false` guard variable
    - Create a wrapper `autoResolve()` that checks `if (resolveInProgress) return`, sets `resolveInProgress = true`, calls `resolveUnknownContacts(false)`, and resets the flag in a `finally` block
    - In `initWhatsApp()` (`src/whatsapp.ts:488`), in the `connection === "open"` handler (line ~577):
      - After `resolveConnection()`, call `void autoResolve().catch(err => console.error('Auto-resolve failed:', err))`
      - Set up `setInterval(() => void autoResolve().catch(err => console.error('Periodic resolve failed:', err)), 30 * 60 * 1000)`
      - Store the interval ID in a module-level variable (like `preKeyPruneInterval`)
    - In `closeWhatsApp()` (`src/whatsapp.ts:761`): Clear the resolve interval

  **Must NOT do**:
  - Don't call `resolveUnknownContacts(true)` (resync=true) automatically — that's slow and triggers full app state sync. Only `resync=false` on auto-resolve.
  - Don't block startup on the resolve — fire-and-forget with error catch
  - Don't add a new exported function — integrate into existing lifecycle
  - Don't allow concurrent resolves — use a `resolveInProgress` boolean guard to prevent overlapping executions

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6, 7)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/whatsapp.ts:577-606` — `connection === "open"` handler — where auto-resolve should be triggered. Add after line 605 (`resolveConnection()`).
  - `src/whatsapp.ts:494-497` — `preKeyPruneInterval` pattern — follow this exact pattern for the resolve interval (store reference, clear on close).
  - `src/whatsapp.ts:761-780` — `closeWhatsApp()` — add interval cleanup here, alongside existing cleanup.
  - `src/whatsapp.ts:232-310` — `resolveUnknownContacts()` — the function being auto-called. With `resync=false`, it skips app state sync and just resolves unmapped LIDs.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/lid-auto-resolve.test.ts` → PASS
  - [ ] `resolveUnknownContacts(false)` called on connection open
  - [ ] 30-minute interval set up
  - [ ] Interval cleared on close

  **QA Scenarios:**
  ```
  Scenario: Auto-resolve fires on startup
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/lid-auto-resolve.test.ts
    Expected Result: All lifecycle assertions pass
    Evidence: .sisyphus/evidence/task-8-auto-resolve.txt

  Scenario: Interval cleanup on close
    Tool: Bash
    Steps:
      1. Same test — verify no lingering intervals after closeWhatsApp()
    Expected Result: Clean shutdown, no interval leaks
    Evidence: .sisyphus/evidence/task-8-cleanup.txt
  ```

  **Commit**: YES
  - Message: `feat(whatsapp): auto-resolve contacts on startup with periodic refresh`
  - Files: `src/whatsapp.ts`, `src/__tests__/lid-auto-resolve.test.ts`
  - Pre-commit: `npx vitest run`

---

- [x] 9. Update tool descriptions + end-to-end integration test

  **What to do**:
  - **Tool description updates** in `src/tools.ts`:
    - `get_unread_messages` (line ~241): Add to description: "This is the recommended way to check for new messages. Contacts with multiple WhatsApp identities are automatically unified into a single view."
    - `list_chats` (line ~37): Add to description: "Contacts with multiple WhatsApp identities are automatically merged into a single entry."
    - `list_messages` (line ~78): Add to description: "Accepts any contact identifier. Messages from all of a contact's identities are returned transparently."
    - `search_messages` (line ~97): Add to description: "Search results automatically unify contacts with multiple identities into a single canonical entry."
    - `search_contacts` (line ~127): Add to description: "Contacts with multiple WhatsApp identities are automatically deduplicated into a single entry."
    - `send_message` (line ~268): Add to description: "Messages are automatically routed to the contact's most recently active thread."
    - **IMPORTANT**: Do NOT reference "LID" in any tool description. Use "multiple identities" or "unified" instead. Agents should not see internal WhatsApp implementation details.
  - **End-to-end integration test** in `src/__tests__/integration/lid-e2e.test.ts`:
    - Set up full MCP test client (via `createMcpTestClient`)
    - Seed LID test data with a mapped pair + unmapped LID
    - Test the complete agent workflow:
      1. Call `get_unread_messages` → verify merged view
      2. Call `search_contacts("Panama")` → verify single deduped result
      3. Call `search_messages("apartment")` → verify canonical `chat` field
      4. Call `list_chats` → verify merged chat entries
      5. Call `list_messages` with phone JID → verify messages from both threads
      6. Call `send_message` with `confirmed=false` (preview) → verify preview shows canonical phone JID and correct contact name (from Task 5's `getRecipientInfo` changes). The actual send routing (Task 6) is verified in the socket-level test, not here.
    - Each assertion verifies the agent sees ONE identity per person

  **Must NOT do**:
  - Don't rename any tools
  - Don't change tool parameter schemas
  - Don't add new tools

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on all prior tasks)
  - **Parallel Group**: Wave 4 (solo)
  - **Blocks**: Final verification wave
  - **Blocked By**: Tasks 2, 3, 4, 5, 6, 7, 8

  **References**:

  **Pattern References**:
  - `src/tools.ts:35-57` — `list_chats` tool definition. Description is on line 37.
  - `src/tools.ts:241-264` — `get_unread_messages` tool definition. Description is on lines 242-244.
  - `src/tools.ts:268-309` — `send_message` tool definition. Description is on lines 270-273.

  **Test References**:
  - `src/__tests__/helpers/mcp-test-client.ts` — MCP test client helper for tool calls.
  - `src/__tests__/integration/search-flow.test.ts` — example of full MCP integration test.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/integration/lid-e2e.test.ts` → PASS
  - [ ] All 6 tool assertions pass in sequence
  - [ ] Tool descriptions updated (grep for "LID" in tools.ts)
  - [ ] `npx vitest run` → all tests pass (full regression)

  **QA Scenarios:**
  ```
  Scenario: Full agent workflow with LID/phone merged contacts
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run src/__tests__/integration/lid-e2e.test.ts
    Expected Result: All 6 tool calls return correct merged/canonical data
    Evidence: .sisyphus/evidence/task-9-e2e.txt

  Scenario: Full regression — no existing tests broken
    Tool: Bash
    Steps:
      1. cd ~/Code/whatsapp-mcp && npx vitest run
      2. Verify 0 failures
    Expected Result: All existing + new tests pass
    Evidence: .sisyphus/evidence/task-9-full-regression.txt

  Scenario: Tool descriptions use agent-friendly language (no internal terms)
    Tool: Bash
    Steps:
      1. grep -c "unified\|multiple identities\|automatically merged\|automatically routed" ~/Code/whatsapp-mcp/src/tools.ts
      2. grep -c "LID" ~/Code/whatsapp-mcp/src/tools.ts (in tool descriptions only, not resolve_contacts)
    Expected Result: At least 6 matches for unified language. LID should NOT appear in tool descriptions for list_chats, list_messages, search_messages, search_contacts, send_message, get_unread_messages. LID is still OK in resolve_contacts description since that tool is explicitly about resolving unknown contacts.
  ```

  **Commit**: YES
  - Message: `docs(tools): update tool descriptions for LID transparency + E2E test`
  - Files: `src/tools.ts`, `src/__tests__/integration/lid-e2e.test.ts`
  - Pre-commit: `npx vitest run`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run function, check output). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + `vitest run`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod (stderr is OK), commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start the WhatsApp MCP server. Call each tool that was modified: `get_unread_messages`, `search_contacts`, `search_messages`, `list_chats`, `send_message` (preview only). Verify LID/phone merge behavior with real contacts. Save evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Tools Verified [N/N] | Merge Correct [Y/N] | Backward Compat [Y/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

All work is in `~/Code/whatsapp-mcp`. Use jj (not git):
- After each task: `jj describe -m "type(scope): desc"` then `jj new`
- After all tasks: `jj bookmark set lid-jid-unification && jj git push`

| Task | Commit Message | Key Files |
|------|---------------|-----------|
| 1 | `feat(db): add getCanonicalJid and getActiveJid helpers` | `src/db.ts`, `src/__tests__/helpers/test-db.ts`, `src/__tests__/lid-helpers.test.ts` |
| 2 | `fix(db): merge LID/phone chats in getUnreadChats` | `src/db.ts`, `src/__tests__/integration/unread-lid.test.ts` |
| 3 | `fix(db): deduplicate LID/phone contacts in searchContacts` | `src/db.ts`, `src/__tests__/integration/search-contacts-lid.test.ts` |
| 4 | `fix(db): canonicalize chat_jid in searchMessages and getRecentMessages` | `src/db.ts`, `src/__tests__/integration/search-messages-lid.test.ts` |
| 5 | `fix(whatsapp): LID-aware name resolution in resolveChatName and getRecipientInfo` | `src/whatsapp.ts`, `src/__tests__/lid-name-resolution.test.ts` |
| 6 | `fix(whatsapp): route sends to active JID for LID contacts` | `src/whatsapp.ts`, `src/__tests__/lid-send-routing.test.ts` |
| 7 | `fix(whatsapp): LID-aware delete operations` | `src/whatsapp.ts`, `src/db.ts`, `src/__tests__/lid-delete.test.ts` |
| 8 | `feat(whatsapp): auto-resolve contacts on startup with periodic refresh` | `src/whatsapp.ts`, `src/__tests__/lid-auto-resolve.test.ts` |
| 9 | `docs(tools): update tool descriptions for LID transparency + E2E test` | `src/tools.ts`, `src/__tests__/integration/lid-e2e.test.ts` |

---

## Success Criteria

### Verification Commands
```bash
# All tests pass (including new LID tests)
cd ~/Code/whatsapp-mcp && npx vitest run

# TypeScript compiles cleanly
cd ~/Code/whatsapp-mcp && npx tsc --noEmit

# Count new LID-specific test files
find ~/Code/whatsapp-mcp/src/__tests__ -name '*lid*' | wc -l  # Expected: >= 7
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Manual QA evidence captured
