# Codex Run-Home and Retained-Session Lifecycle — Architecture Review

## Recommended architecture

Keep one private `CODEX_HOME` per local Codex run. Treat its lifecycle as two
ordered records: the raw run home and a bounded, best-effort-redacted retained
counterpart. Normal deletion remains gated on runtime close, terminal run and
directory ownership, zero open handles, age beyond grace, and exact retained
JSONL coverage.

`buildRuntime` owns a startup rollback record as soon as the run home exists. A
failure before any transport-start attempt may remove that provably unused home.
If cleanup fails, or transport startup was attempted, Paperclip preserves the
home, writes a versioned quarantine marker, and emits
`acpx.codex_run_home.quarantine`.

Every run-home sweeper treats the producer's sibling `<run-id>.quarantine` file
as an unconditional deletion veto before retained-proof or terminal-orphan
evaluation. A directory or symlink with that suffix is not the producer shape
and fails closed as an invalid marker path.

Retention reads at most 8 MiB per JSONL and 32 MiB per run before synchronous
redaction. Any oversize, unreadable, invalid-text, or partial copy quarantines
the raw home. Completed retained runs use a 30-day TTL plus per-agent caps of
1,000 runs and 1 GiB. Cleanup is auditable and dry-run by default; destructive
execution requires an explicit operator flag and is not scheduled. Cap
selection continues past protected raw-home counterparts, and the manifest
reports any residual run/byte excess that fail-closed exclusions prevent it
from removing.

Hard-loss homes without a counterpart remain undeletable. The raw-home dry-run
manifest classifies them and separately reports whether the stricter review
preconditions hold: terminal ownership, at least seven days old and at least
twice the normal grace, zero open handles, and zero raw JSONL. The report does
not implement or authorize recovery deletion.
Inspection failures, hard-loss-orphan counts, and bytes at risk are explicit
aggregate fields and CLI summary values. Empty run wrappers are reported but
never mutated by the sweeper because they can be a live startup window.

## Risks

- Security: best-effort redaction cannot prove removal of novel secret formats;
  retained files stay private and time/size bounded.
- Data integrity: deleting retention while a raw home exists could invalidate
  the normal four-condition delete proof; the retention sweeper blocks it.
- Operational: a hard crash can bypass in-process marker creation. The dry-run
  sweeper makes terminal no-counterpart homes explicit without deleting them.
- Race safety: a transport-start attempt makes home usage ambiguous, so startup
  rollback quarantines rather than inferring that the home is unused.

## Migration impact

- Files affected: `packages/adapter-utils/src/acpx-engine/execute.ts`, both
  lifecycle sweepers and tests, and `doc/DEVELOPING.md`.
- Downtime: no.
- Rollback plan:
  1. Disable any manually configured retention cleanup invocation.
  2. Revert the code change; no database migration or format rewrite is needed.
  3. Preserve existing raw homes, retained runs, manifests, and markers.
  4. Re-run both sweepers in dry-run mode and compare manifests before any later
     cleanup decision.

## Files likely affected

- `packages/adapter-utils/src/acpx-engine/execute.ts`
- `packages/adapter-utils/src/acpx-engine/execute.test.ts`
- `packages/adapter-utils/src/acpx-engine/run-home-sweeper.ts`
- `packages/adapter-utils/src/acpx-engine/run-home-sweeper.test.ts`
- `packages/adapter-utils/src/acpx-engine/session-retention-sweeper.ts`
- `packages/adapter-utils/src/acpx-engine/session-retention-sweeper.test.ts`
- `doc/DEVELOPING.md`

## What must be tested

- Pre-deploy: startup cleanup success/failure, partial transport startup,
  oversize/unreadable retention, exact-counterpart delete, terminal no-counterpart
  reporting, TTL/cap dry runs, raw-home exclusion, marker cleanup, typecheck, and
  exact-head CI.
- Post-deploy: live success, cancellation/failure, active-run exclusion, and
  hard server-loss canaries; confirm quarantine events and both dry-run manifests.

## Approval gates

No no-counterpart raw-home deletion is implemented. Do not schedule retained
transcript deletion, run either sweeper destructively, deploy, or merge until the
operator approves the exact head and a fresh independent Claude review reports
no material lifecycle or data finding.

## Decision rationale

This design preserves the existing automatic-delete invariant and adds evidence
where process loss previously created silent permanent orphans. Automatically
deleting terminal no-counterpart homes was rejected because terminal status and
age do not prove that no session data would be lost. Keeping retained data
forever was rejected because it merely relocates unbounded sensitive growth.
Streaming arbitrary JSONL through the existing synchronous redactor was rejected
because that redactor's contract requires a caller-side bound; fixed-size reads
make the memory and redaction input limits explicit.
