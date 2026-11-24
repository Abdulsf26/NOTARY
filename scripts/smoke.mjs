// Notary smoke test — proves the whole loop offline, no browser, no API keys.
// Exits 1 on any failure. Run: npm run smoke
import { createWorld, createFaults } from '../src/core/world.js';
import { runTask, HERO_TASK } from '../src/core/agent.js';
import { verifyChain } from '../src/core/receipts.js';
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY, TOTAL_REGISTRY_TOKENS } from '../src/core/registry.js';

let fail = 0;
const check = (name, cond) => { console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`); if (!cond) fail++; };

console.log('notary smoke · offline · no keys\n');

// 1) compiler sanity
const r = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
const ids = new Set(r.selected.map(t => t.id));
console.log('compiler @ budget 900:');
for (const need of ['drive.search_files', 'notion.read_page', 'notion.append_block', 'slack.post_in_channel', 'crm.log_activity']) {
  check(`compiled surface contains ${need}`, ids.has(need));
}
check('F ≥ greedy baseline (enumeration never loses)', r.F + 1e-9 >= r.greedyF);
check('surface respects budget', r.usedCost <= 900);
check('certificate bound ≥ deterministic cost', r.certificate.bound >= r.certificate.deterministic);

// 2) notary-protected run catches the silent no-op
console.log('\nprotected run (fault injection armed):');
const worldA = createWorld(); const faultsA = createFaults(); faultsA.silentNoOp = true;
const protected_ = await runTask({ query: HERO_TASK, budget: 900, lambda: 0.5, emit: () => {}, world: worldA, faults: faultsA, prevHash: null });
check('verdict CONFIRMED after bounded retry', protected_.verdict === 'CONFIRMED');
check('false success was caught and counted', protected_.receipt.falseSuccessCaught >= 1);
check('receipt hash-chain is valid', (await verifyChain([protected_.receipt])).valid);

// 3) baseline gets fooled by the same fault
console.log('\nbaseline run (no protection):');
const worldB = createWorld(); const faultsB = createFaults(); faultsB.silentNoOp = true;
const baseline = await runTask({ query: HERO_TASK, baseline: true, emit: () => {}, world: worldB, faults: faultsB });
check('baseline declared victory while a write silently no-oped', baseline.fooled >= 1);
check('baseline produced no receipt (nothing to audit)', !('receipt' in baseline));

console.log(fail === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
