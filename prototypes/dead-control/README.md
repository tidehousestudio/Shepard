# Dead-control detector — prototype

Evidence that Shepard's core detection mechanism works mechanically, with no model
calls and no knowledge of the application under test.

The fixture is a small page with four buttons and three links. Two defects are
planted in it: `#subscribe` has had its click handler removed, and `#terms` points at
a page that does not exist. Nothing tells the detector which those are, or what any
control is supposed to do.

The detector enumerates every interactive element, then for each one snapshots the
DOM, URL and storage, clicks it, and records whether *any* observable effect
followed — a DOM mutation, a navigation, a storage write, or a network request —
along with any console error or 4xx/5xx response.

A control with an empty effect set is inert. A control whose effect set includes an
error is broken. Neither judgement requires knowing the control's purpose, which is
why this class of check survives a defect that was planted in the code itself.

## Run

    npx http-server -p 8933 -s fixture &
    node detect.mjs

## Observed output

    ok   effective button#add     "Add to cart"       dom
    ok   effective button#save    "Save draft"        storage
    ok   effective button#refresh "Refresh prices"    network:1
    >>>  INERT     button#subscribe "Subscribe"       (no observable effect)
    ok   effective a#home         "Home"              network:1
    ok   effective a#docs         "Docs"              dom,navigation,network:1
    >>>  ERRORED   a#terms        "Terms"             ! HTTP 404 /terms.html

Both planted defects found. This is a prototype of the mechanism, not the production
implementation: the real engine adds per-control effect baselines, stability
confirmation across repeated runs, authenticated roles, and database-level effects.
