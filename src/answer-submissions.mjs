import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { queueWithCodex } from './diagnostics.mjs';
import { ContextError } from './context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const payloadDigest = value => hash(JSON.stringify([value.projectId, value.sessionId, value.answers, value.prompt]));
export const questionFingerprint = q => JSON.stringify([q.id, q.text, q.options ?? []]);
const held = new Set(['sending','queued','delivery_unconfirmed']);
const fail = (message, code = 409) => { throw new ContextError(message, code); };

// A stale lock is never automatically removed: a crashed owner requires explicit
// recovery, rather than risking duplicate dispatch across processes.
function withLock(store, work) {
  const lock = join(store.dataDir, 'answer-dispatch.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('Answer dispatch is locked or a previous lock needs manual recovery. No retry was attempted.'); throw error; }
  try { store.refresh(); return work(); } finally { rmdirSync(lock); }
}
function scope(snapshot) {
  const { id: projectId, sessionId, sessions } = snapshot.project;
  if (!projectId || !sessionId || !sessions?.some(value => value.id === sessionId)) fail('An enrolled project and chat are required.');
  return { projectId, sessionId };
}
function inputAnswers(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) fail('Choose 1–20 answers.', 400);
  const ids = new Set(); let total = 0;
  return value.map(item => {
    if (!item || typeof item.questionId !== 'string' || !item.questionId || item.questionId.length > 4096 || ids.has(item.questionId) || typeof item.answer !== 'string' || !item.answer.trim() || item.answer.length > 4000) fail('Each answer needs a unique question and 1–4000 characters.', 400);
    ids.add(item.questionId); total += item.answer.length;
    if (total > 40000) fail('The answer batch is too large.', 400);
    return { questionId: item.questionId, answer: item.answer };
  });
}
function envelope(id, owner, answers) {
  const body = answers.map(value => `Question: ${value.questionText}\nFlux question ID: ${value.questionId}\nYour answer:\n${value.answer}`).join('\n\n---\n\n');
  return `Flux answer submission ${id}\nProject: ${owner.projectId}\nChat: ${owner.sessionId}\n\n${body}`;
}
const replyEventId = (requestId, questionId) => `answer-reply:${hash(JSON.stringify([requestId,questionId]))}`;
function validCapturedMessage(message, request) {
  return Boolean(message && message.kind === 'message.user' && message.provenance === 'user' && message.source?.type === 'transcript' && message.projectId === request.projectId && message.sessionId === request.sessionId && message.text === request.prompt && payloadDigest(request) === request.payloadHash);
}
export function projectAnswerSubmissions(events, project) {
  const submissions = new Map(), byId = new Map(events.map(event => [event.id,event]));
  for (const event of events) {
    if (event.projectId !== project.id || event.sessionId !== project.sessionId) continue;
    const data = event.data ?? {};
    if (event.kind === 'answer_submission_prepared') {
      const value = data.submission;
      if (value && typeof value.id === 'string' && event.id === `answer-submission:${value.id}` && event.source?.type === 'flux_answers' && event.source.ref === value.id && value.projectId === project.id && value.sessionId === project.sessionId && value.status === 'prepared' && Array.isArray(value.answers) && value.answers.length > 0 && value.answers.every(answer => answer && typeof answer.questionId === 'string' && typeof answer.questionText === 'string' && typeof answer.questionFingerprint === 'string' && typeof answer.answer === 'string') && typeof value.prompt === 'string' && payloadDigest(value) === value.payloadHash && !submissions.has(value.id)) submissions.set(value.id, structuredClone(value));
    }
    const value = submissions.get(data.requestId);
    if (!value) continue;
    if (event.kind === 'answer_submission_started' && event.id === `answer-started:${value.id}` && value.status === 'prepared') { value.status = 'sending'; value.ownerPid = data.ownerPid; value.startedAt = event.at; }
    if (event.kind === 'answer_submission_queued' && event.id === `answer-queued:${value.id}` && ['sending','delivery_unconfirmed'].includes(value.status)) value.status = 'queued';
    if (event.kind === 'answer_submission_unconfirmed' && event.id === `answer-unconfirmed:${value.id}` && ['sending','queued'].includes(value.status)) { value.status = 'delivery_unconfirmed'; value.error = data.error; }
    const outcomesValid = Array.isArray(data.outcomes) && data.outcomes.length === value.answers.length && data.outcomes.every((outcome,index) => outcome?.questionId === value.answers[index].questionId && ['reply_recorded','already_replied','conflict'].includes(outcome.status));
    if (event.kind === 'answer_submission_received' && event.id === `answer-received:${value.id}` && held.has(value.status) && outcomesValid && validCapturedMessage(byId.get(data.sourceEventId),value)) { value.status = 'received'; value.receiptSourceId = data.sourceEventId; value.outcomes = data.outcomes; delete value.error; }
    if (event.kind === 'answer_submission_outcome' && value.status === 'received' && data.status === 'conflict' && event.id === `answer-conflict:${hash(JSON.stringify([value.id,data.questionId]))}`) value.outcomes = value.outcomes.map(outcome => outcome.questionId === data.questionId ? { ...outcome, status: data.status } : outcome);
  }
  const values = [...submissions.values()];
  return { answerSubmissions: values, answerHolds: values.filter(value => held.has(value.status)).flatMap(value => value.answers.map(answer => ({ questionId: answer.questionId, submissionId: value.id, status: value.status }))) };
}
export async function submitAnswers(store, input, { queueCommand = queueWithCodex } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.dispatch !== 'boolean') fail('Specify an answer batch and dispatch mode.', 400);
  const answers = inputAnswers(input.answers);
  if (!input.dispatch) {
    if (input.requestId !== undefined) fail('Prepare without a request ID.', 400);
    return withLock(store, () => {
      const snapshot = store.snapshot(), owner = scope(snapshot);
      if (input.expectedRevision !== snapshot.contextRevision) fail('The chat context changed. Refresh and review again.');
      const pending = new Map(snapshot.incomingQuestions.pending.map(q => [q.id,q]));
      const frozen = answers.map(answer => {
        const q = pending.get(answer.questionId);
        if (!q) fail('A selected question is no longer pending.');
        if (snapshot.answerHolds.some(hold => hold.questionId === q.id)) fail('A selected question already has a delivery in progress or unconfirmed.');
        return { ...answer, questionText: q.text, questionFingerprint: questionFingerprint(q) };
      });
      const id = randomUUID(), prompt = envelope(id, owner, frozen);
      if (Buffer.byteLength(prompt) > 60000) fail('The answer batch is too large.', 400);
      const submission = { id, ...owner, status:'prepared', answers:frozen, prompt, payloadHash:'', contextRevision:snapshot.contextRevision };
      submission.payloadHash = payloadDigest(submission);
      store.append({ id:`answer-submission:${id}`, kind:'answer_submission_prepared', ...owner, actor:'Flux', provenance:'user', summary:'Answer message prepared', source:{type:'flux_answers',ref:id}, data:{submission} });
      return submission;
    });
  }
  if (typeof input.requestId !== 'string' || !input.requestId) fail('A reviewed request ID is required.', 400);
  const reservation = withLock(store, () => {
    const snapshot = store.snapshot(), owner = scope(snapshot);
    const request = snapshot.answerSubmissions.find(value => value.id === input.requestId);
    if (!request || request.projectId !== owner.projectId || request.sessionId !== owner.sessionId) fail('The reviewed answer message is unavailable.', 404);
    if (input.expectedRevision !== request.contextRevision || JSON.stringify(answers) !== JSON.stringify(request.answers.map(({questionId,answer}) => ({questionId,answer}))) || payloadDigest(request) !== request.payloadHash) fail('The reviewed answers changed. Review again.');
    if (request.status !== 'prepared') return { request, reserved:false };
    if (request.answers.some(answer => snapshot.answerHolds.some(hold => hold.questionId === answer.questionId))) fail('A selected question already has a delivery in progress or unconfirmed.');
    if (snapshot.contextRevision !== request.contextRevision) fail('The chat context changed. Refresh and review again.');
    const pending = new Map(snapshot.incomingQuestions.pending.map(q => [q.id,q]));
    for (const answer of request.answers) {
      const question = pending.get(answer.questionId);
      if (!question || questionFingerprint(question) !== answer.questionFingerprint) fail('A selected question changed or is no longer pending.');
      if (snapshot.answerHolds.some(hold => hold.questionId === answer.questionId)) fail('A selected question already has a delivery in progress or unconfirmed.');
    }
    store.append({id:`answer-started:${request.id}`,kind:'answer_submission_started',...owner,actor:'Flux',provenance:'observed',summary:'Answer message delivery started',data:{requestId:request.id,ownerPid:process.pid}});
    return {request:{...request,status:'sending'},reserved:true};
  });
  if (!reservation.reserved) return reservation.request;
  const request = reservation.request;
  try {
    await queueCommand({sessionId:request.sessionId,prompt:request.prompt,requestId:request.id});
    store.append({id:`answer-queued:${request.id}`,kind:'answer_submission_queued',projectId:request.projectId,sessionId:request.sessionId,actor:'Flux',provenance:'observed',summary:'Answer message queued',data:{requestId:request.id}});
  } catch (error) {
    store.append({id:`answer-unconfirmed:${request.id}`,kind:'answer_submission_unconfirmed',projectId:request.projectId,sessionId:request.sessionId,actor:'Flux',provenance:'observed',summary:'Answer message delivery unconfirmed',data:{requestId:request.id,error:String(error?.message || 'Delivery could not be confirmed.').slice(0,600)}});
  }
  return store.snapshot().answerSubmissions.find(value => value.id === request.id) ?? request;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
/** Recover abandoned reservations without sending or releasing their holds. */
export function recoverAnswerReservations(store, { isAlive = processAlive } = {}) {
  try {
    return withLock(store, () => {
      const snapshot = store.snapshot();
      let recovered = 0;
      for (const request of snapshot.answerSubmissions) {
        if (request.status !== 'sending' || isAlive(request.ownerPid)) continue;
        store.append({id:`answer-unconfirmed:${request.id}`,kind:'answer_submission_unconfirmed',projectId:request.projectId,sessionId:request.sessionId,actor:'Flux',provenance:'observed',summary:'Answer delivery unconfirmed after the sending process ended',data:{requestId:request.id,error:'The sending process ended before delivery was confirmed. Check the connected chat; Flux will not retry automatically.'}});
        recovered++;
      }
      return { recovered };
    });
  } catch (error) {
    if (error.statusCode === 409) return { recovered:0, locked:true };
    throw error;
  }
}

export function exactAnswerMessage(snapshot, raw) {
  if (typeof raw !== 'string') return undefined;
  return snapshot.answerSubmissions.find(value => ['sending','queued','delivery_unconfirmed','received'].includes(value.status) && value.projectId === snapshot.project.id && value.sessionId === snapshot.project.sessionId && value.prompt === raw && payloadDigest(value) === value.payloadHash);
}

// Receipt is derived only from the exact enrolled public message. Each resolution
// is independent so a prior external reply or closure cannot be overwritten.
export function reconcileAnswerSubmissions(store) {
  try {
    return withLock(store, () => {
      let snapshot = store.snapshot();
      const eventsById = new Map(snapshot.events.map(event => [event.id,event]));
      const messages = new Map(snapshot.events.filter(event => event.kind === 'message.user' && event.provenance === 'user' && event.source?.type === 'transcript' && event.projectId === snapshot.project.id && event.sessionId === snapshot.project.sessionId).map(event => [event.text,event]));
      for (const request of snapshot.answerSubmissions.filter(value => ['sending','queued','delivery_unconfirmed','received'].includes(value.status))) {
        if (request.status === 'received' && request.outcomes.every(outcome => outcome.status !== 'reply_recorded' || eventsById.has(replyEventId(request.id,outcome.questionId)))) continue;
        let receipt = request.status === 'received' ? eventsById.get(`answer-received:${request.id}`) : undefined;
        const message = receipt ? eventsById.get(receipt.data.sourceEventId) : messages.get(request.prompt);
        if (!validCapturedMessage(message,request)) continue;
        if (!receipt) {
          const pending = new Map(snapshot.incomingQuestions.pending.map(question => [question.id,question]));
          const history = new Map(snapshot.incomingQuestions.history.map(question => [question.id,question]));
          const outcomes = request.answers.map(answer => {
            const current = pending.get(answer.questionId), previous = history.get(answer.questionId);
            return {questionId:answer.questionId, status: current && questionFingerprint(current) === answer.questionFingerprint ? 'reply_recorded' : previous?.status === 'replied' && previous.answer === answer.answer ? 'already_replied' : 'conflict'};
          });
          receipt = store.append({id:`answer-received:${request.id}`,kind:'answer_submission_received',projectId:request.projectId,sessionId:request.sessionId,actor:'Flux',provenance:'observed',summary:'Answer message captured in chat',data:{requestId:request.id,sourceEventId:message.id,outcomes}});
          const verified = store.snapshot().answerSubmissions.find(value => value.id === request.id);
          if (verified?.status !== 'received' || verified.receiptSourceId !== message.id) continue;
        }
        for (const outcome of receipt.data.outcomes ?? []) {
          if (outcome.status !== 'reply_recorded') continue;
          snapshot = store.snapshot();
          const answer = request.answers.find(value => value.questionId === outcome.questionId);
          const pending = snapshot.incomingQuestions.pending.find(q => q.id === outcome.questionId);
          if (!answer) continue;
          const id = replyEventId(request.id,answer.questionId);
          if (!pending || questionFingerprint(pending) !== answer.questionFingerprint) {
            if (!snapshot.events.some(event => event.id === id)) store.append({id:`answer-conflict:${hash(JSON.stringify([request.id,answer.questionId]))}`,kind:'answer_submission_outcome',projectId:request.projectId,sessionId:request.sessionId,actor:'Flux',provenance:'observed',summary:'Answer receipt conflicts with a later question state',data:{requestId:request.id,questionId:answer.questionId,status:'conflict'}});
            continue;
          }
          store.append({id,kind:'question_resolved',projectId:request.projectId,sessionId:request.sessionId,actor:'You',provenance:'user',summary:'Question reply recorded',text:answer.answer,source:{type:'transcript',ref:message.source.ref},data:{resolution:{questionId:answer.questionId,status:'replied',answer:answer.answer,sourceIds:[message.id]}}});
        }
        snapshot = store.snapshot();
      }
    });
  } catch (error) {
    // A live or stale lock fails closed; a later import poll can reconcile.
    if (error.statusCode === 409) return;
    throw error;
  }
}

export function markVerifiedAnswerMessages(events, submissions) {
  const byId = new Map(submissions.map(value => [value.id,value]));
  const eventsById = new Map(events.map(event => [event.id,event]));
  const verified = new Map();
  for (const event of events) {
    if (event.kind !== 'answer_submission_received') continue;
    const request = byId.get(event.data?.requestId), message = eventsById.get(event.data?.sourceEventId);
    if (!request || request.status !== 'received' || event.id !== `answer-received:${request.id}` || request.receiptSourceId !== message?.id || !message || event.projectId !== request.projectId || event.sessionId !== request.sessionId || message.projectId !== request.projectId || message.sessionId !== request.sessionId || message.kind !== 'message.user' || message.provenance !== 'user' || message.source?.type !== 'transcript' || message.text !== request.prompt || payloadDigest(request) !== request.payloadHash) continue;
    verified.set(message.id, request.answers.map(answer => `Question: ${answer.questionText}\nAnswer:\n${answer.answer}`).join('\n\n'));
  }
  return events.map(event => verified.has(event.id) ? { ...event, data:{...event.data,verifiedAnswerSubmission:true,answerDirection:verified.get(event.id)} } : event);
}
