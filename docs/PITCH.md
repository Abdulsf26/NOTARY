# Notary — Demo & Pitch Playbook
*(team working doc — not for judges' eyes; the README is the public face)*

## The 90-second demo (three beats — order is sacred)

**Beat 1 — THE BOMB (0:00–0:25).** Baseline meter full: the registry on the wire. Flip Notary on: the compiled surface (≈ 7% of tokens). One line: *“This is the tax everyone pays. Nothing has happened yet.”* The certificate appears: **≤ ~N tokens at 95% confidence, α = 0.05.** Beat.

**Beat 2 — THE LIE DETECTOR (0:25–0:55).** Fault injection ON. The agent calls `notion.append_block` → **200 OK**. Baseline would say “Done!” Notary reads the page back → block missing → screen flashes **CONTRADICTED** → bounded retry (resolve real parent) → read-back → **CONFIRMED**, block visible on screen. One line: *“Every agent you've ever used has this bug. You just watched us catch it.”*

**Beat 3 — THE VOICE (0:55–1:15).** Receipt time. It is **spoken aloud**: *“Posted to engineering. Verified. Within quote.”* Close: **“Quote before. Receipt after. Less magic, more utility.”**

Rule: never open with architecture. Cost → Truth → Access. Head → gut → heart.

## The 5-minute pitch skeleton

**0:00 Hook (no intro).** “A year ago an agent saying *Done* was impressive. Today it's a liability. Three MCP servers eat 72% of your context before the user speaks. Accuracy falls from 43% to under 14% as the catalog grows. And when an agent says it created a record, nobody in this room can prove it. We built the thing that lets you prove it.”

**0:30 Problem (3 numbers, 1 slide).** 72% context tax · 43→14% accuracy cliff · 0% of writes verifiable (FSR invisible). 

**1:30 Idea + theory.** “We displace the decision out of inference.” One line objective, submodular, (1−1/e) via ≤3-seed enumeration, quantile certificate with union bound. Then the worked example slide: *“We threw away the second-most-relevant tool in the registry, on purpose.”*

**3:00 Demo.** Beats 1–3 live. Say almost nothing during it.

**4:00 Does it work + can it ship.** Five metrics slide · AWS/ElevenLabs mapping in one line · “We built three of six layers; the other three are designed, costed, and broken into tasks.”

**4:30 Close.** “Everyone else is making agents smarter. We're making them **accountable**. Quote before. Receipt after. Less magic, more utility — and the reason your CISO finally says yes.”

## Q&A battlecard (≤ 20 s each)

| Judge asks | Answer |
|---|---|
| Retrieval already fixes this (RAG-MCP, Tool Search, Code Mode) | “They cut the tax — real, and we sit alongside them. But input-side repairs recover ≤ 23% of failures; the model already sees the right tool 80% of the time. We reduce the number of decisions, and we add the two things none of them has: a pre-flight commitment and proof of effect.” |
| Why hasn't Anthropic/Cloudflare built it? | “They're building the client — for themselves. A certificate and receipt are only valuable independent of the auditor. Neutral layer, same reason Stripe exists next to Visa.” |
| Isn't this just LangSmith/Arize observability? | “Observability is after the fact — it tells you what last Tuesday cost. A certificate is a commitment; a receipt is proof. A dashboard can't refuse the run.” |
| Submodular is old — Sviridenko 2004 | “Applying proven maths where it hasn't been applied is the point. Nobody framed tool-surface selection as costed submodular selection with a redundancy term, and nobody ships it as a user-facing certificate.” |
| Verification is impossible in general | “Fully general, yes. Per-tool postconditions, no: one read-back call for ~30 write tools out of 600. Cover the calls that can cost money.” |
| Model ignores your surface and asks for an excluded tool | “Fails closed — and that's a feature. Hallucinating a tool name is documented behaviour; failing closed is auditable. Fail closed is what you want at 2 a.m.” |
| Latency? | “~0.2–0.5 s to save 40–72% of the window — and read-back usually replaces a retry you'd have paid for anyway.” |
| Bigger model? | “Bigger models delay the cliff, don't remove it — at 107 tools large and small models both fail completely. And 200K context still loses 72% to three servers.” |
| Business model? | “Per-verified-action pricing + compliance tier. Buyer: the person who signs off on deploying writes. Today that person says no.” |
| What's actually hard? | “Two things: calibrating per-tool token distributions (cold start: bootstrap from schema size, α = 0.20 week 1, tighten as logs accumulate, publish the breach curve) and choosing λ so the objective stays monotone (the §5.3 clamp).” |
| Your eval is 30 tasks? | “Correct — it's a hackathon. Protocol: BFCL-derived + LiveMCPBench-style + injected-fault. The silent no-op injector IS the demo.” |
| If this works, why not Visa/Stripe? | “‘AI action’ only became a payment-shaped thing this year. That's the window we're standing in.” |

## Slide notes
- Template: mandatory wHACKiest26 deck, no extra slides, `HACKATHON2WIN_Track1` filename.
- §5.7 worked-example table belongs on the Proposed Solution or Novelty slide — judges love a concrete number.
- Competitive quadrant: cost-guaranteeing × effect-verifying; everyone else is bottom-right; we're top-right alone.
