# Shepard — Analysis and Architecture

Status: design, pre-implementation. Written 2026-09-21.

This document is my reading of what Shepard is, the architecture I intend to build,
the improvements I want to make to the brief, and the things that genuinely block
the loop from running.

---

## 1. What Shepard actually is

Shepard answers one question — *is this application still behaving correctly?* — and
the interesting part is that it has to earn the right to answer it.

Five inversions separate Shepard from monitoring:

1. **It derives its own specification.** Nobody tells Shepard what the app does or
   what to check. It reads the repository and works it out.
2. **It uses the product.** Reading code tells you what was written, not what
   happens. Shepard has to drive the running application the way a user does.
3. **It can refuse.** Connection is not acceptance. Acceptance is a verdict Shepard
   issues after it has evidence of a healthy baseline. This is the structural idea
   that makes the rest trustworthy: it prevents Shepard from learning broken
   behaviour as the normal it later protects.
4. **It is three-valued.** Healthy, broken, and *unverified* are different. Silence
   is not health. A system that quietly rounds "I couldn't check" up to "fine" is
   worse than no system, because it manufactures false confidence.
5. **It accumulates.** Knowledge lives outside any one model conversation and gets
   better with time on a repository.

And its success is measured adversarially: defects are planted without telling it,
and finding ten real bugs while missing the planted one is a failed test.

The UI philosophy follows from this. If Shepard works, you should not need to look
at it. The screen exists to tell you whether to stop what you are doing, and
nothing else.

---

## 2. The hardest problem: the oracle

Everything difficult about Shepard reduces to one question: **where does the
expectation come from?**

The obvious answer — read the code, derive intent, test the app against it — is
circular exactly where it matters. If the defect is in the code, the expectation
derived from that code inherits the defect, and Shepard confirms the bug as correct
behaviour. A planted defect that deletes a click handler produces a code-derived
expectation of "this button does nothing," which the running app satisfies
perfectly. Shepard reports healthy. Test failed.

So the architecture has to be built around this rule:

> **Anti-circularity rule.** An expectation derived from the same code that
> implements the behaviour can never, on its own, support a *verified healthy*
> verdict. It can only support *consistent with implementation*, which is weaker.

A healthy verdict needs at least one expectation source that is independent of the
implementation. Shepard uses five, chosen because they fail in different ways:

| Source | What it gives | Survives a code-level planted defect? |
|---|---|---|
| **Affordance semantics** | A control labelled "Add to cart" must change the cart. A link must resolve. A form must persist. These are product truths, not codebase truths. | Yes — this is the primary one |
| **Cross-layer contradiction** | Schema vs. API vs. UI vs. access policy. A column nothing writes, a policy the UI never exercises, a route with no caller. | Yes — a defect in one layer shows as disagreement with another |
| **Git history as intent** | What this code did last week. A deletion-shaped defect is a regression against recent history. | Yes |
| **Universal invariants** | No unhandled console error, no 4xx/5xx on a nominal journey, no broken internal link, no inert control, auth boundary holds in the negative direction. | Yes |
| **Code-derived intent** | Fine-grained expectations: what this handler is trying to do, what this function returns. | **No** — supporting evidence only |

Two consequences worth naming:

**The dead-control detector.** Every interactive affordance must produce an
observable effect — a DOM change, a network call, a navigation, a storage write, a
database row. Shepard records the effect at baseline. A control whose effect set
collapses to empty is a defect, and it is detectable *without knowing what the
control was for*. "Intentionally break a button" is precisely this class.

**Negative verification is first class.** Every case carries polarity. Proving the
admin can reach something does not prove the anonymous visitor cannot, and in a
multi-tenant app it certainly does not prove tenant B cannot. Shepard generates the
negative case alongside the positive one, for every boundary it discovers.

---

## 3. Execution model: never production

**Shepard verifies an ephemeral instance built from the repository at a commit. It
does not test production.**

This is a decision, not an option, and it falls out of the brief's own requirements
rather than from caution:

- Requirement 5 asks for verified database changes. You cannot assert on production
  rows, and you certainly cannot write them.
- Requirement 5 asks for negative and destructive testing. Deleting things to prove
  deletion works is only acceptable against a disposable instance.
- Requirement 8 asks that nothing charge money or send messages. Against an
  ephemeral instance, outbound integrations are stubbed at the network boundary, so
  this is guaranteed by construction rather than by the model's good judgement.
- Audits have to be comparable over time. Production state drifts; a seeded
  instance does not.

Production gets a read-only liveness and parity probe at most, and only with
explicit permission.

The cost of this decision is that Shepard must learn to **build and boot an
unfamiliar application**, and I want to be straightforward that this is where most
of the engineering difficulty and most of the wall-clock hour actually goes. It
becomes its own subsystem, *environment acquisition*: detect stack and package
manager, read compose files, CI workflows and env examples, provision a local
database, run migrations, seed, boot, wait for health, and record exactly what it
could not satisfy. When it cannot boot, the honest answer is `unverified: could not
acquire environment`, reported loudly — not a source-code summary dressed up as an
audit.

---

## 4. Discovery → verification surface → cases

Onboarding runs as a pipeline, each stage writing structured rows to the knowledge
store rather than passing prose forward.

1. **Inventory.** Clone at a commit. Map the repository: languages, frameworks,
   entry points, routes, components, API handlers and serverless functions,
   migrations, schema, access policies, background jobs, third-party clients,
   configuration, tests, CI.
2. **Comprehension.** What is this application, who uses it, what are its systems
   and journeys? Produced from the inventory, expressed as typed entities — Actor,
   System, Journey, Surface — not a paragraph. The prose report the user reads is
   rendered *from* those entities, which is what makes the user's correction in
   requirement 4 actionable: a correction lands on a row, not on a blob of text.
3. **Verification surface.** Every discovered thing that can be exercised: routes,
   controls, forms, endpoints, functions, auth states, roles, tables, policies,
   integrations, journeys. Each carries a safety classification — safe, needs
   sandbox, or cannot be safely automated — derived from what it touches.
4. **Case generation.** Surfaces become executable verification cases: preconditions,
   actor, steps, expected observations, polarity, and which expectation sources
   justify it. Cases are stored artifacts, not prompts.
5. **Execution.** Deterministic. Browser driven by Playwright with console, network,
   screenshot and trace capture; direct API calls; direct database assertions;
   stubbed integrations recording what *would* have been sent.
6. **Adjudication.** Observations vs. expectations, producing pass / fail /
   inconclusive — never a silent pass. Inconclusive is a real outcome with a reason.
7. **Confirmation.** A candidate failure is re-executed independently before it
   becomes a finding. Non-reproducible failures become `intermittent`, which is its
   own class and its own signal, not noise to be dropped.
8. **Qualification.** Acceptance or denial, with the evidence that supports it.

### The split that makes this affordable

**Claude discovers, plans and investigates. Deterministic scripts execute.**

Once a verification case is discovered, it is a stored, replayable artifact. A
scheduled audit is therefore mostly deterministic replay plus model triage of the
diffs, not an hour of re-improvisation. This buys three things at once: audits
become cheap and fast, results become comparable across runs, and the flakiness
that would otherwise make a reliability system cry wolf mostly disappears. Model
time is then spent where it is actually worth spending — on discovering new surface,
and on investigating deviations.

---

## 5. Knowledge

Model context is working memory and nothing more. It compacts, it resets, it is
lost. Shepard's memory is a database.

SQLite per repository, with content-addressed evidence blobs on disk (screenshots,
traces, HAR, logs, stdout). Single file, no operational burden, transactional,
queryable, trivially backed up, and directly inspectable — which matters, because
an accountable system's memory should be readable by a human who doubts it.

Core entities: `application`, `system`, `actor`, `journey`, `surface`,
`expectation`, `verification_case`, `run`, `observation`, `evidence`, `finding`,
`finding_event`, `baseline`, `exception`, `audit_cycle`, `blind_spot`.

Three design points that carry weight:

**Finding identity.** Findings need a stable fingerprint so that New / Known /
Resolved / Recurrence / Intentional is computed rather than guessed. The fingerprint
keys on the semantic location and failure class — surface identity plus failure
kind plus normalised signature — never on line numbers or exact message text, both
of which move for cosmetic reasons.

**Baseline as a contract.** When Shepard accepts a repository it records *what it
accepted*: the case set, the expected observations, coverage, and the explicit list
of what it could not verify. Acceptance then means something auditable, and
re-qualification after a change is a diff against that manifest rather than a fresh
opinion.

**Blind spots.** When the user corrects Shepard, the durable artifact is not the
fact — it is the methodology defect. Record what class of thing was missed, why the
discovery pass did not reach it, and the new heuristic that would have caught it.
Facts make Shepard know one repository better. Blind spots make Shepard better at
every repository. This is the mechanism by which requirement 18's failures turn into
general improvement instead of special-casing.

---

## 6. Health, findings and scheduling

Health is derived from the knowledge store, not from the last command's exit code.
It is a function over per-system states, which are functions over the current status
of the cases covering each system. A system with no passing coverage is not healthy;
it is unverified, and it says so.

**Severity is journey-weighted.** A console warning on a marketing page and a
failing checkout are not the same event, and grading them by error type produces a
"needs attention: 5" that nobody reads. Severity derives from which discovered
journey the failing surface participates in and how central that journey is.

**Coverage is reported alongside health.** "Healthy at 14% coverage" and "healthy at
81% coverage" are different claims and should never render identically. This is
requirement 6 made visible rather than merely internal, and it belongs on the sparse
main screen.

Scheduling starts as plain recurring audits with a selection step: the audit cycle
chooses what to verify based on what changed since the last cycle, what is highest
severity, what is stale, and what previously failed. Change-awareness is not a later
phase — the diff since last audit is the cheapest high-yield signal available — but
the *trigger* can stay a timer until deployment hooks are worth building.

---

## 7. Baseline evolution

An accepted application keeps changing, and not every difference is a regression.
When the repository moves, Shepard determines what changed, maps it to impacted
surfaces through the dependency map, decides whether existing expectations still
hold, generates cases for genuinely new behaviour, verifies, and then revises the
baseline as a recorded event with a reason. The baseline is versioned and its
history is queryable: *when did we start believing this was correct, and on what
evidence?*

Intentional-behaviour exceptions (requirement 10) are scoped and falsifiable rather
than permanent mutes. An exception binds to a fingerprint, carries the user's stated
reason, and carries the observable condition under which it holds. Shepard
reconciles the claim against what it can observe instead of accepting it as
technical truth, and when the surrounding code changes the exception reopens for
re-confirmation rather than suppressing a real regression forever.

---

## 8. Testing Shepard itself

Requirement 18 is the real acceptance test of this build, and I want to go further
than waiting for defects to be planted by hand.

**Mutation harness.** Shepard should be able to plant defects in a throwaway copy of
a repository, run its own audit, and measure whether it caught them. A mutation
catalogue drawn from realistic failure classes: remove a click handler, break an
internal link, invert an authorisation check, drop a database write, return the
wrong status code, break a form's validation, make a query ignore its tenant filter,
introduce an N+1 that only shows under seeded volume.

That turns "did Shepard find the planted bug?" from an occasional manual exercise
into a continuous, automated measure of Shepard's sensitivity, per defect class.
When a class scores badly, the fix is to the discovery and verification methodology
responsible for it — which is the stated goal — and the harness proves the fix
generalises instead of hardcoding around one incident.

It is, in effect, Shepard's own test suite, asking the only question that matters:
*does Shepard still have eyes?*

---

## 9. Interface

Full viewport, monospace, mostly empty, no chrome.

```
SHEPARD

repository: <name>
health: healthy.
coverage: 78%
last audit: 08:32.
critical: 0
need attention: 5
```

Findings and chat are reachable but not shown. Chat is grounded in the knowledge
store by retrieval, so it answers from what Shepard has established and can cite the
evidence, rather than behaving like a fresh model conversation.

The pixel scene is driven by a single derived state enum and nothing else. To the
states in the brief I want to add one: **blind**. If the last audit could not run,
or coverage has collapsed, the scene should show fog — the sheep are out there
somewhere and the shepherd cannot see them. A system with three-valued logic must
not have a two-valued picture; if Shepard cannot see, the sheep must not look safe.

---

## 10. Stack

Node and TypeScript end to end. Playwright is first-class there, the target
applications are TypeScript, and one language across engine and interface keeps the
surface small. SQLite for knowledge. A small HTTP API and a minimal front end —
no framework weight for a screen that renders eight lines of text and a canvas.
Model access through the Claude API with strict typed outputs per stage, each stage
a bounded call with a retrieved context slice rather than one long conversation.

---

## 11. Risks, honestly

- **Booting unfamiliar applications is the practical blocker.** Env vars, databases,
  seed data, third-party keys. Expect `unverified: could not acquire environment` to
  be common until this subsystem is good, and expect it to need user-supplied
  configuration for most real apps.
- **Authentication.** Exercising roles requires test accounts. For most applications
  Shepard cannot invent them; it needs either self-registration or credentials for a
  test environment. This is a designed-for onboarding input, not something to hack
  around.
- **Empty databases hide bugs.** Shepard should build its own state through the
  product — register, create, transact — rather than assert against a bare schema.
- **Cost and time.** Deep onboarding is expensive by design. The replay/triage split
  is what keeps the recurring cost sane.
- **Non-determinism.** Handled by the confirmation rule and by keeping execution
  deterministic, but it needs watching: a reliability system that flaps gets ignored,
  and an ignored Shepard is a failed Shepard.

---

## 12. Build order

| Phase | Content |
|---|---|
| 0 | Skeleton, knowledge store, model client, evidence store |
| 1 | Connect a repository, static discovery, understanding report, correction loop |
| 2 | Environment acquisition — build and boot the app locally |
| 3 | Verification surface, case generation, execution, adjudication |
| 4 | Acceptance, denial, baseline manifest |
| 5 | Findings lifecycle, health, scheduled audits |
| 6 | Chat, interface, pixel scene |
| 7 | Mutation harness, change-aware audit selection |

Phases 2 and 3 are the product. Phase 7 is how we find out whether any of it is real.
