const { jobDb, learningDb } = require('../server/db');
const { finalizeAutoRepairAttempt } = require('../server/retrospective-worker');
const job = jobDb.findById('J000001');
if (!job) { console.error('no job'); process.exit(1); }
const outcome = job.output.repair;
const attempt = finalizeAutoRepairAttempt(job, { metrics: outcome.metrics, artifacts: outcome.artifacts, pipeline: outcome.pipeline, gateEvidence: outcome.gate_evidence });
const att = learningDb.findAttemptByJobId('J000001');
console.log('attempt=' + att.id + ' auto_status=' + att.auto_status + ' human_verdict=' + att.human_verdict);
console.log('metrics=' + JSON.stringify(att.metrics));
const ge = job.gate_evidence || {};
const g = ge.quality_gates || {};
console.log('gate=' + g.clipping_review);
const m = ge.raw ? ge.raw.match(/frames_sampled.: (\d+)/) : null;
console.log('frames_sampled=' + (m ? m[1] : 'n/a'));
console.log('glb_sha=' + (att.artifacts && att.artifacts.glb_sha));
