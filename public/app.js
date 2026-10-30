'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const tabs = ['Overview', 'Plan', 'Timeline', 'Changes', 'Decisions', 'Context'];
  const questions = ['Where are we with the current plan?', 'Why are we working on this now?', 'Audit progress since the last saved plan', 'Find unfinished work', 'Challenge the evidence for completion'];
  const isNarrowViewport = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
  const ui = {tab:'Overview', selected:{type:'project',id:'flux'}, inspectorOpen:false, scopeOpen:false, timelineMode:'meaningful', session:'', actor:'', saved:'', kind:'', search:'', contextSearch:'', baseline:'', current:'', followLatest:true, question:questions[0], included:null, limit:70, contextLimit:45, planView:'list', contextMode:'relevant', reviewNote:''};
  let data = null;
  let loading = false;
  let loadingAgain = false;
  let prepared = null;
  let preparedBody = null;
  let processing = false;
  let composerDirty = false;
  let composerScope = '';
  let composerCandidates = [];
  let reviewBusy = false;
  let stream = null;
  let streamConnected = false;

  const contextRevision = record => record?.contextRevision ?? record?.revision;

  const eventMap = () => new Map((data?.events || []).map(event => [event.id, event]));
  const items = () => data?.overview?.workItems || data?.project?.items || [];
  const plans = () => data?.overview?.history?.plans || data?.project?.plans || [];
  const decisions = () => data?.overview?.history?.decisions || data?.project?.decisions || [];
  const sessions = () => data?.project?.sessions || [];
  const str = value => typeof value === 'string' ? value : value ? JSON.stringify(value) : '';
  const short = (text, max = 160) => {const value = str(text); return value.length > max ? value.slice(0,max).trimEnd() + '…' : value;};
  const label = value => ({curated_history:'Reconstructed from public messages',authorized_work:'Approved work','message.user':'User message','message.assistant':'Codex message','model.configured':'Model setting','usage.tokens':'Token usage',plan_saved:'Checkpoint',item_updated:'Work status',project_patch:'Project update',ready_for_review:'Ready for review',in_progress:'In progress'}[value] || str(value).replace(/[_.-]/g,' ').replace(/\b\w/g,char => char.toUpperCase()));
  const date = (at, options = {}) => {const when = new Date(at); return Number.isNaN(when.getTime()) ? 'Time not recorded' : new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...options}).format(when);};
  const time = at => date(at,{month:undefined,day:undefined});
  const provenanceLabel = provenance => ({observed:'Observed',agent_report:'Agent report',inferred:'Inferred',user:'User instruction'}[provenance] || 'Not classified');
  const tone = status => /fail|error|rejected/i.test(status || '') ? 'fail' : /wait|unverified|pending|need|blocked|prepared|parked/i.test(status || '') ? 'warn' : /active|progress|verified|queued|approved|complete|done|ready_for_review/i.test(status || '') ? 'active' : '';
  const iconMarkup=(name,className='inline-icon')=>`<i class="${className}" data-lucide="${name}" aria-hidden="true"></i>`;
  const statusIcon=name=>({verified:'badge-check',approved:'badge-check','in progress':'clock-3',queued:'clock-3',acknowledged:'clock-3','ready for review':'eye',ready_for_review:'eye',proposed:'lightbulb',suggestion:'lightbulb',parked:'circle-pause','not approved':'circle-help','needs verification':'triangle-alert','needs an update':'circle-alert',unknown:'circle-help',failed:'circle-x'}[str(name).toLowerCase()] || '');
  const renderIcons=root=>window.fluxIcons?.render(root);
  const tag = (text, color = '') => {const glyph=statusIcon(text);return `<span class="tag ${color}${glyph?' tag-with-icon':''}">${glyph?iconMarkup(glyph):''}${escape(text)}</span>`;};
  function setCallout(message, color='') {
    const icon=color==='fail'?'circle-x':color==='warn'?'triangle-alert':color==='active'?'circle-check-big':'info';
    const node=$('diagnostic-message');node.className='callout '+color;node.innerHTML=`${iconMarkup(icon,'callout-icon')}<span>${escape(message)}</span>`;renderIcons(node);
  }
  function setButtonLabel(id, text, icon) {
    const button=$(id);button.innerHTML=`${iconMarkup(icon,'button-icon')}<span>${escape(text)}</span>`;renderIcons(button);
  }
  function enhanceDisclosureSummaries(root) {
    root.querySelectorAll('details > summary').forEach(summary=>{
      if(summary.querySelector('[data-flux-chevron]'))return;
      const chevron=document.createElement('i');
      chevron.className='disclosure-chevron';
      chevron.setAttribute('data-flux-chevron','');
      chevron.setAttribute('data-lucide','chevron-right');
      chevron.setAttribute('aria-hidden','true');
      summary.insertBefore(chevron,summary.firstChild);
    });
    renderIcons(root);
  }
  const tokenNumber = (value,compact=false) => Number.isSafeInteger(value) && value>=0 ? new Intl.NumberFormat('en-US',compact?{notation:'compact',maximumFractionDigits:1}:{}).format(value) : 'Not reported';
  const configuredModel = record => record.data?.configuredModel || (record.kind==='model.configured' ? record.data?.model : null);
  function nativeBadges(record) {
    const model=configuredModel(record),usage=record.kind==='usage.tokens'?record.data?.usage:null;
    return (model && record.kind!=='model.configured' ? tag('Configured: '+model,'tag-outline model-badge') : '') + (usage && Number.isSafeInteger(usage.total_tokens) ? tag(tokenNumber(usage.total_tokens,true)+' tokens','tag-outline token-badge') : '');
  }
  function nativeFields(record) {
    const model=configuredModel(record),usage=record.kind==='usage.tokens'?record.data?.usage:null;
    let fields=model ? `<div><dt>Configured model</dt><dd class="mono">${escape(model)}</dd></div>` : '';
    if(!usage)return fields;
    fields+=`<div><dt>Token scope</dt><dd>One model response</dd></div><div><dt>Total tokens</dt><dd class="mono">${tokenNumber(usage.total_tokens)}</dd></div><div><dt>Input tokens</dt><dd class="mono">${tokenNumber(usage.input_tokens)}</dd></div><div><dt>Cached input</dt><dd class="mono">${tokenNumber(usage.cached_input_tokens)}<span class="usage-note">Already included in input.</span></dd></div><div><dt>Output tokens</dt><dd class="mono">${tokenNumber(usage.output_tokens)}</dd></div>`;
    const turn=record.data?.turnUsage?.total_tokens,thread=record.data?.threadUsage?.total_tokens;
    if(Number.isSafeInteger(turn)||Number.isSafeInteger(thread))fields+=`<div><dt>Native cumulative counters</dt><dd><details class="usage-cumulative"><summary>Turn and chat totals</summary><p>Turn: <span class="mono">${tokenNumber(turn)}</span><br>Chat: <span class="mono">${tokenNumber(thread)}</span></p></details></dd></div>`;
    return fields;
  }
  const sessionTitle = id => sessions().find(session => session.id === id)?.title || (id ? short(id,22) : 'This project');
  const missingInfo = value => ({session:'The enrolled chat is not identified.',goal:'The goal is not recorded.',goal_sources:'The goal has no linked source.',direction:'No current user direction is recorded.',direction_time:'The current direction has no recorded time.',focus:'The current work needs to be recorded.',focus_anchor:'The recorded work is not linked to a current user instruction.',focus_time:'The recorded focus has no update time.',now:'What is happening now is not recorded.',why:'The reason for the current work is not recorded.',next:'The next step is not recorded.'}[value] || 'Some recorded information is missing.');
  const meaningfulEvents = () => (data.overview?.events || []).filter(event=>!['report','update'].includes(event.category));
  const isClosed = item => /^(done|complete|completed|verified|superseded|cancelled|canceled)$/i.test(item.status || '');
  const checkEvidence = record => record.evidence?.kind==='checks_recorded' || sourcesFor(record).some(event=>/^verification|^test[._]result/.test(event.kind) && event.provenance==='observed');
  const needsVerification = item => /unverified|verification|claimed/i.test(item.status || '') || (/complete|done|verified/i.test(item.status || '') && !checkEvidence(item));
  const statusLabel = item => item.review?.outcome==='accepted' ? 'Accepted by you' : item.review?.outcome==='changes_requested' ? 'Changes requested' : /^(verified|verified_complete)$/i.test(item.status || '') ? (checkEvidence(item) && item.evidenceScope!=='checkpoint' ? 'Complete · checks recorded' : 'Reported verified') : /^(complete|completed|done)$/i.test(item.status || '') ? (checkEvidence(item)?'Complete · checks recorded':'Complete · reported') : label(item.status || 'Not recorded');
  const isReview = item => /^(ready_for_review|ready-for-review)$/.test(item.status || '');
  const hasCheckpoint = () => ['current','needs_update'].includes(data?.overview?.focus?.status);
  const comparable = (a,b) => Boolean(a && b && a.id!==b.id && (!(a.sessionId && b.sessionId) || a.sessionId===b.sessionId) && (a.scopeId && b.scopeId ? a.scopeId===b.scopeId : (a.steps || []).some(step=>(b.steps || []).some(other=>other.id===step.id))));
  const selectionIs = (type,id,planId) => ui.selected.type === type && ui.selected.id === id && (type!=='step' || ui.selected.planId===planId);
  const selectionAttr = (type,id,planId) => `data-select-type="${type}" data-select="${escape(id)}"${planId ? ` data-select-plan="${escape(planId)}"` : ''} aria-pressed="${selectionIs(type,id,planId)}"`;
  const latestPlan = () => plans().at(-1);
  const currentPlan = () => plans().find(plan => plan.id === ui.current) || latestPlan();
  const baselinePlan = () => plans().find(plan => plan.id === ui.baseline) || [...plans()].slice(0,plans().indexOf(currentPlan())).reverse().find(plan=>comparable(plan,currentPlan()));
  const intentText = () => {
    if(data?.overview?.direction?.text)return data.overview.direction.text;
    const intent = data?.project?.latestIntent;
    const user=[...(data?.events || [])].reverse().find(event => event.provenance==='user' && ['message.user','user_message','message'].includes(event.kind) && !/^Flux diagnostic /i.test(event.text || event.summary || ''));
    const anchorIndex=(data?.events || []).findIndex(event => event.id===data?.project?.latestIntentSourceId);
    if (user && (anchorIndex<0 || data.events.indexOf(user)>anchorIndex)) return user.text || user.summary;
    return typeof intent === 'string' ? intent : intent?.text || intent?.summary || data?.project?.goal || 'No current intent recorded.';
  };
  function sourcesFor(record) {
    const map = eventMap();
    return [...new Set(record?.sourceIds || [])].map(id => map.get(id)).filter(Boolean);
  }
  function filterRecord(record) {
    if (ui.session && record.sessionId && record.sessionId !== ui.session) return false;
    if (ui.actor && (record.actor || record.owner) !== ui.actor) return false;
    if (ui.saved === 'open' && isClosed(record)) return false;
    if (ui.saved === 'verify' && !needsVerification(record)) return false;
    return true;
  }
  function savePreferences() {
    if (!data) return;
    try {localStorage.setItem('flux:' + data.project.id, JSON.stringify({version:2,tab:ui.tab,selected:ui.selected,baseline:ui.baseline,current:ui.current,followLatest:ui.followLatest,question:ui.question,included:ui.included,timelineMode:ui.timelineMode}));} catch {}
  }
  function restorePreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem('flux:' + data.project.id) || 'null');
      if (!saved) return;
      if (saved.version===2 && tabs.includes(saved.tab)) ui.tab = saved.tab;
      if (saved.selected && ['item','event','plan','step','decision','project'].includes(saved.selected.type)) ui.selected = saved.selected;
      if (ui.selected.type==='step' && !ui.selected.planId) ui.selected={type:'project',id:data.project.id};
      if (questions.includes(saved.question)) ui.question = saved.question;
      ui.current = saved.current || ''; ui.baseline = saved.baseline || ''; if(!comparable(plans().find(p=>p.id===ui.baseline),currentPlan()))ui.baseline='';
      ui.followLatest = saved.followLatest !== false;
      if (Array.isArray(saved.included)) ui.included = saved.included;
      if(saved.version===2 && ['meaningful','all'].includes(saved.timelineMode))ui.timelineMode=saved.timelineMode;
    } catch {}
  }
  function announce(text) { $('announcement').textContent = text; }
  function coverageDescription() {
    const coverage = data?.coverage;
    if (!coverage) return 'Partial capture · public chat and recorded updates';
    if (typeof coverage === 'string') return coverage;
    return coverage.summary || coverage.description || 'Partial capture · public chat and recorded updates';
  }
  function suggestedSources() {
    const selected=selectedRecord();
    let ids=selected.sources.map(source=>source.id);
    if(selected.kind==='project'){
      const events=data.events || [], focus=data.overview?.focus;
      const focusEvent=[...events].reverse().find(event=>event.kind==='project_patch' && event.data?.patch?.focus?.intentSourceId===focus?.intentSourceId && event.data?.patch?.focus?.title===focus?.title);
      const checkpoint=[...events].reverse().find(event=>event.kind==='plan_saved' && event.data?.plan?.id===latestPlan()?.id);
      const supporting=[...(focus?.sourceIds || []),...(latestPlan()?.sourceIds || [])];
      const checks=supporting.filter(id=>eventMap().get(id)?.kind==='verification');
      ids=[focusEvent?.id,checkpoint?.id,...checks,...(!focusEvent?focus?.sourceIds || []:[])];
      const mandatory=new Set(data.overview?.direction?.sourceIds || []);
      return [...new Set(ids)].filter(id=>id && eventMap().has(id) && !mandatory.has(id)).slice(0,5);
    }
    return [...new Set(ids)].filter(id=>eventMap().has(id)).slice(0,40);
  }

  function initializeContext() {
    const known=eventMap();
    if(ui.included!==null){ui.included=ui.included.filter(id=>known.has(id));return;}
    ui.included=suggestedSources();
  }
  function selectedRecord() {
    const kind = ui.selected.type;
    const id = ui.selected.id;
    if (kind === 'item') {
      const record = items().find(item => item.id === id);
      if (record) return {kind,record,sources:sourcesFor(record)};
    }
    if (kind === 'event') {
      const record = eventMap().get(id);
      if (record) return {kind,record,sources:[record]};
    }
    if (kind === 'decision') {
      const record = decisions().find(decision => decision.id === id);
      if (record) return {kind,record,sources:sourcesFor(record)};
    }
    if (kind === 'plan') {
      const record = plans().find(plan => plan.id === id);
      if (record) return {kind,record,sources:sourcesFor(record)};
    }
    if (kind === 'step') {
      const plan = plans().find(plan => plan.id===ui.selected.planId);
      const step = plan?.steps?.find(step => step.id === id);
      if (step) {
        const record = {...step,at:plan.at,sessionId:step.sessionId || plan.sessionId,provenance:step.provenance || (plan.kind==='curated_history'?'inferred':'agent_report'),sourceIds:step.sourceIds?.length?step.sourceIds:plan.sourceIds};
        return {kind,record,plan,sources:sourcesFor(record)};
      }
    }
    const focus=data.overview?.focus;
    const purpose=hasCheckpoint() ? `Now: ${data.overview.now?.text || 'Not recorded'}\nWhy: ${data.overview.why?.text || 'Not recorded'}\nNext: ${data.overview.next?.text || 'Not recorded'}` : intentText();
    return {kind:'project',record:{...data.project,purpose},sources:sourcesFor(focus)};
  }
  function scopeName() {
    const parts = [ui.session ? sessionTitle(ui.session) : sessions().length<=1?'This chat':'All enrolled chats'];
    if (ui.actor) parts.push(ui.actor);
    if (ui.saved) parts.push(ui.saved === 'open' ? 'Unfinished work' : 'Needs verification');
    return parts.join(' · ');
  }
  function renderSidebar() {
    const actors = [...new Set([...(data.events || []).map(event => event.actor),...items().map(item => item.owner)])].filter(actor => actor && !/^(user|system|tool)$/i.test(actor)).slice(0,12);
    const sideButton = (attrs,text,count,icon='folder',active=false) => `<button class="side-button" type="button" ${attrs} aria-pressed="${active}">${iconMarkup(icon,'side-icon')}<span class="side-label">${escape(text)}</span>${count !== undefined ? `<span class="count">${escape(count)}</span>` : ''}</button>`;
    const sidebar=$('sidebar');
    sidebar.innerHTML = `<div class="side-group"><p class="side-title">Project</p>${sideButton('data-project-reset',data.project.title,undefined,'folder',!ui.session&&!ui.actor&&!ui.saved)}</div><div class="side-group"><p class="side-title">Related chats</p>${sideButton('data-session=""',sessions().length<=1?'This chat':'All enrolled chats',sessions().length,'messages-square',!ui.session)}${sessions().map(session => sideButton(`data-session="${escape(session.id)}"`,session.title,(data.events || []).filter(event => event.sessionId === session.id).length,'message-square',ui.session===session.id)).join('')}</div><div class="side-group"><p class="side-title">Agents</p>${sideButton('data-actor=""','All participants',undefined,'users',!ui.actor)}${actors.map(actor => sideButton(`data-actor="${escape(actor)}"`,actor,(data.events || []).filter(event => event.actor === actor).length,'bot',ui.actor===actor)).join('')}</div><div class="side-group"><p class="side-title">Saved views</p>${sideButton('data-saved="open"','Unfinished work',items().filter(item => !isClosed(item)).length,'list-todo',ui.saved==='open')}${sideButton('data-saved="verify"','Needs verification',items().filter(needsVerification).length,'triangle-alert',ui.saved==='verify')}</div><div class="side-note"><strong>Connected to this chat</strong><br>Public messages and tool metadata are captured locally. Recorded plans and rationale come from explicit updates.<br><br>Unrecorded work remains unknown.</div>`;
    const filterHeading=document.createElement('div');
    filterHeading.className='filter-panel-head';
    filterHeading.innerHTML='<p class="side-title">Filters</p><button id="scope-close" class="quiet-button" type="button" data-close-scope>Done</button>';
    sidebar.insertBefore(filterHeading,sidebar.firstChild);
    renderIcons(sidebar);
  }
  function node(item, type = 'item', planId) {
    const evidence = sourcesFor(item);
    const sourceText = item.provenance ? provenanceLabel(item.provenance) : evidence.length ? [...new Set(evidence.map(event => provenanceLabel(event.provenance)))].join(' + ') : 'No linked source';
    return `<button type="button" class="plan-node" ${selectionAttr(type,item.id,planId)}><span class="node-top"><span class="node-title">${escape(item.title)}</span>${tag(statusLabel(item),tone(item.status))}</span><span class="node-meta">${escape(item.owner || 'Codex')} · ${escape(sourceText)}${item.evidenceScope==='checkpoint'?' · Checkpoint sources':''}</span>${item.returnCondition ? `<span class="node-meta">Return: ${escape(short(item.returnCondition,120))}</span>` : ''}</button>`;
  }
  function overviewSources(card, text='View source') {
    const sourceIds=[...new Set(card?.sourceIds || [])].filter(id=>eventMap().has(id));
    return sourceIds.length ? `<details class="overview-source"><summary>${escape(text)} · ${sourceIds.length} source${sourceIds.length===1?'':'s'}</summary><div class="flex">${sourceIds.map(id=>`<button type="button" class="text-button" ${selectionAttr('event',id)}>${escape(short(eventMap().get(id)?.summary || id,70))} ↗</button>`).join('')}</div></details>` : '';
  }
  function overviewAuditTrail(overview) {
    const cards=[overview.direction,overview.why,overview.now,overview.next];
    const ids=[...new Set(cards.flatMap(card=>card?.sourceIds || []))].filter(id=>eventMap().has(id));
    const sources=ids.map(id=>eventMap().get(id)).sort((a,b)=>new Date(a.at || 0)-new Date(b.at || 0));
    if(!sources.length)return '';
    const glyph={user:'user-round',observed:'badge-check',agent_report:'bot',inferred:'lightbulb'};
    const rows=sources.map(event=>{
      const kind=event.provenance || 'unknown';
      const icon=glyph[kind] || 'file-question';
      const title=event.summary || event.text || event.kind || 'Recorded source';
      const detail=[provenanceLabel(kind),event.actor || 'Source',event.at?date(event.at):'Time not recorded'].join(' · ');
      return `<div class="audit-source"><span class="audit-source-icon">${iconMarkup(icon)}</span><span class="audit-source-copy"><span class="audit-source-title">${escape(short(title,105))}</span><span class="audit-source-meta">${escape(detail)}</span></span><button type="button" class="audit-inspect" ${selectionAttr('event',event.id)} aria-label="Inspect ${escape(short(title,70))}">${iconMarkup('arrow-up-right')}</button></div>`;
    }).join('');
    return `<details class="overview-audit" data-disclosure-key="audit-trail"><summary>${iconMarkup('git-branch')}<span>How we got here</span><span class="audit-count">${sources.length} linked record${sources.length===1?'':'s'}</span></summary><div class="audit-trail">${rows}</div></details>`;
  }
  function currentDirection() {
    const overview=data.overview || {};
    const focus=overview.focus || {};
    const current=hasCheckpoint();
    const text=current ? overview.now?.text : overview.direction?.text || intentText();
    return `<section class="current-direction"><p class="overview-label">${focus.status==='needs_update'?'Last known focus':current?'Current focus':'Latest user direction'}</p><h3>${escape(current?text || 'Current focus is not recorded.':short(text,220))}</h3>${!current ? '<p class="small muted">The recorded focus needs an update. Earlier checkpoints remain historical.</p>' : ''}${overviewSources(current?overview.now:overview.direction)}</section>`;
  }
  function overviewView() {
    const overview=data.overview || {};
    const focus=overview.focus || {};
    const current=hasCheckpoint();
    const stale=focus.status==='needs_update';
    const now=current ? overview.now?.text || 'Current focus is not recorded.' : stale ? 'A newer user message needs review' : 'Current focus isn’t recorded';
    const direction=overview.direction?.text || intentText();
    const why=current && overview.why?.text ? overview.why.text : 'A reason for the current direction has not been recorded.';
    const next=current && overview.next?.text ? overview.next.text : 'The next step has not been recorded.';
    const nextStatus=overview.next?.status;
    const state=stale ? 'Last checkpoint' : current ? statusLabel({status:focus.workStatus || 'Recorded focus',provenance:overview.now?.provenance}) : stale ? 'Needs an update' : 'Unknown';
    const activity=meaningfulEvents().filter(event=>['verification','answer','artifact'].includes(event.category)).slice(0,4);
    const open=overview.openWork || {};
    const review=(open.active || []).filter(isReview);
    const waitingWork=(open.active || []).filter(record=>/waiting|blocked/.test(record.status));
    const active=(open.active || []).filter(record=>!isReview(record)&&!waitingWork.includes(record));
    const unknown=open.unknown || [];
    const parked=open.parked || [];
    const proposals=open.proposals || [];
    const waiting=(data.requests || []).filter(request=>['queued','acknowledged'].includes(request.status));
    const completed=items().filter(item=>/^(done|complete|completed|verified)$/.test(item.status));
    const row=(record,type,description,status)=>{
      const glyph=statusIcon(status);
      const state=status || (record.at ? date(record.at,{hour:undefined,minute:undefined}) : '');
      const provenance=record.provenance && status ? `<span class="overview-provenance-chip" data-provenance="${escape(record.provenance)}">${iconMarkup(({user:'user-round',observed:'badge-check',agent_report:'bot',inferred:'lightbulb'})[record.provenance] || 'file-question')}<span>${escape(provenanceLabel(record.provenance))}</span></span>` : '';
      const statusKey=str(status).toLowerCase().replace(/[ -]+/g,'_');
      return `<button type="button" class="overview-row" ${selectionAttr(type,record.id)}><span><span class="overview-title">${escape(record.title || record.summary || 'Recorded update')}</span><span class="overview-description">${escape(description || '')}</span></span><span class="overview-row-signals">${state?`<span class="overview-status-chip"${status?` data-work-status="${escape(statusKey)}"`:''}>${glyph?iconMarkup(glyph):''}<span>${escape(state)}</span></span>`:''}${provenance}</span></button>`;
    };
    return `${stale ? `<section class="pending-direction" aria-label="Latest request"><strong>New request · current work needs an update</strong><p>${escape(direction)}</p><small>The checkpoint below is the last recorded state. Your new request takes precedence.</small></section>` : ''}<section class="overview-focus" aria-label="Current work and next step">
      <div class="overview-now">
        <div class="overview-state"><p class="overview-label">${stale?'Last known work':'Now'}</p>${tag(state,current?tone(focus.workStatus):'warn')}<span class="overview-provenance-chip"${current&&overview.now?.provenance?` data-provenance="${escape(overview.now.provenance)}"`:''}>${iconMarkup(current?(({user:'user-round',observed:'badge-check',agent_report:'bot',inferred:'lightbulb'})[overview.now?.provenance] || 'file-question'):'user-round')}<span>${current?escape(provenanceLabel(overview.now?.provenance)):'Latest user direction'}</span></span></div>
        <h2 class="overview-current">${escape(now)}</h2><p class="checkpoint-time">${focus.updatedAt?`Checkpoint recorded ${escape(date(focus.updatedAt))}`:"Checkpoint time not recorded"}</p>
        ${!current ? `<p class="overview-description">${escape(direction)}</p>` : ''}
        <div class="overview-why"><p class="overview-label">Why now</p><p>${escape(why)}</p></div>
        ${overviewAuditTrail(overview)}
      </div>
      <section class="overview-next" aria-label="Next step">
        <div><p class="overview-label">${stale?'Previously recorded next step':'Next'}</p><p class="overview-next-text">${escape(next)}</p><p class="overview-next-status">${current&&overview.next?.text?(nextStatus==='suggested'||nextStatus==='proposed'?'Suggested':nextStatus==='planned'?'Planned step':'Recorded next step'):'Not recorded'}</p></div>
        <div class="overview-next-action"><button type="button" class="primary-button" data-overview-ask="Where are we with the current plan?">${iconMarkup('message-square-text')}<span>Ask about progress</span></button><p class="small muted">Review a question and its sources.</p></div>
      </section>
    </section>
    <section class="overview-section attention-section" aria-label="Needs your review"><h3>Needs your review <span class="section-count">${review.length}</span></h3>${review.length?review.map(record=>row(record,'item',record.purpose,'Ready for review')).join(''):'<p class="small muted">No work is currently awaiting your review.</p>'}</section>
    ${waitingWork.length?`<section class="overview-section"><h3>Waiting or blocked <span class="section-count">${waitingWork.length}</span></h3>${waitingWork.map(record=>row(record,'item',record.purpose,statusLabel(record))).join('')}</section>`:''}
    ${unknown.length?`<section class="overview-section"><h3>Status needs clarification <span class="section-count">${unknown.length}</span></h3>${unknown.map(record=>row(record,'item',record.purpose,statusLabel(record))).join('')}</section>`:''}
    <div class="overview-columns">
      <section class="overview-section"><div class="overview-section-heading"><h3>Recent outcomes</h3><button type="button" class="text-button" data-tab="Timeline">View timeline</button></div>${activity.length ? activity.map(record=>row(record,'event',record.text && record.text!==record.summary?short(record.text,120):provenanceLabel(record.provenance))).join('') : '<p class="muted small">No outcomes have been recorded yet. Instructions and activity remain in Timeline.</p>'}</section>
      <section class="overview-section overview-open-work"><h3>${active.length?'Open work':'For later'}</h3>${active.map(record=>row(record,'item',record.purpose,statusLabel(record))).join('')}${parked.length||proposals.length?`<div class="overview-later-groups"><section class="overview-later-group"><h4>${iconMarkup('circle-pause')}<span>Parked</span><span class="overview-later-count">${parked.length}</span></h4>${parked.length?parked.map(record=>row(record,'item',record.returnCondition?(/^resume when\b/i.test(record.returnCondition)?record.returnCondition:`Resume when: ${record.returnCondition}`):record.purpose,'Parked')).join(''):'<p class="overview-later-empty">No parked work.</p>'}</section><section class="overview-later-group overview-suggestions"><h4>${iconMarkup('lightbulb')}<span>Suggestions</span><span class="overview-later-count">${proposals.length}</span></h4>${proposals.length?proposals.map(record=>row(record,record.entityType || 'item',record.purpose || record.rationale,'Not approved')).join(''):'<p class="overview-later-empty">No suggestions.</p>'}</section></div>`:''}${!active.length&&!parked.length&&!proposals.length ? '<p class="muted small">No open work or proposals are recorded.</p>' : ''}${waiting.length ? `<p class="small muted">${waiting.length} question${waiting.length===1?' is':'s are'} waiting for an answer.</p>` : ''}<button type="button" class="text-button" data-tab="Decisions">Review decisions</button></section>
    </div>
    <details class="overview-settled" data-disclosure-key="completed-work"><summary>Completed work and recorded checks · ${completed.length}</summary>${completed.length ? completed.map(record=>row(record,'item',record.purpose,statusLabel(record))).join('') : '<p class="muted small">No completed work is recorded.</p>'}</details>
    <section class="overview-actions"><button type="button" class="text-button" data-overview-ask="Why are we working on this now?">${iconMarkup('message-square-text')}<span>Ask why we’re doing this</span></button><button type="button" class="text-button" data-overview-ask="Find unfinished work">${iconMarkup('message-square-text')}<span>Find unfinished work</span></button><button type="button" class="text-button" data-tab="Context">${iconMarkup('files')}<span>Choose question sources</span></button></section>
    ${(overview.unknowns || []).length ? `<details class="overview-settled"><summary>Information still missing</summary>${overview.unknowns.map(value=>`<p class="small muted">${escape(missingInfo(value))}</p>`).join('')}</details>` : ''}`;
  }
  function planView() {
    const plan=currentPlan(), visible=items().filter(filterRecord);
    const later=visible.filter(item=>/^(parked|deferred|shelved|paused|on_hold|on-hold|proposal|proposed|suggested|idea|optional)$/.test(item.status));
    const open=visible.filter(item=>!isClosed(item)&&!later.includes(item)), closed=visible.filter(isClosed);
    const options=[...plans()].reverse().map(record=>`<option value="${escape(record.id)}" ${record.id===plan?.id?'selected':''}>${escape(record.title)}</option>`).join('');
    const tree=(records)=>{
      const visited=new Set(), ids=new Set(records.map(item=>item.id));
      const hasOpenDescendant=(item,seen=new Set())=>{if(seen.has(item.id))return false;seen.add(item.id);return !isClosed(item) || records.filter(child=>child.parentId===item.id).some(child=>hasOpenDescendant(child,seen));};
      const branch=(item,depth=0)=>{
        if(visited.has(item.id))return '';
        visited.add(item.id);
        const children=depth<8?records.filter(child=>child.parentId===item.id):[];
        return `<li>${node(item)}${children.length?`<details class="map-branch" data-disclosure-key="map-${escape(item.id)}" ${hasOpenDescendant(item)?'open':''}><summary>${children.length} related ${children.length===1?'item':'items'}</summary><ul>${children.map(child=>branch(child,depth+1)).join('')}</ul></details>`:''}</li>`;
      };
      const roots=records.filter(item=>!item.parentId || !ids.has(item.parentId));
      const body=roots.map(item=>branch(item)).join('');
      const rest=records.filter(item=>!visited.has(item.id)).map(item=>branch(item)).join('');
      return `<div class="work-map"><p class="small muted">Lines show recorded parent relationships, not inferred dependencies. Select a node to inspect or review its work.</p><div class="map-goal">${escape(data.project.goal)}</div><ul>${body}${rest}</ul></div>`;
    };
    return `${currentDirection()}<section class="current-work"><div class="overview-section-heading"><h3>${ui.planView==='map'?'Recorded work · '+visible.length:'Current work · '+open.length}</h3><div class="view-toggle"><button type="button" data-plan-view="list" aria-pressed="${ui.planView==='list'}">List</button><button type="button" data-plan-view="map" aria-pressed="${ui.planView==='map'}">Work map</button></div></div>${ui.planView==='map'?tree(visible):`${open.map(record=>node(record)).join('') || '<p class="small muted">No open work matches this view.</p>'}${later.length?`<details data-disclosure-key="later-work"><summary>Parked and proposed · ${later.length}</summary>${later.map(record=>node(record)).join('')}</details>`:''}<details data-disclosure-key="past-work"><summary>Completed and superseded work · ${closed.length}</summary>${closed.map(record=>node(record)).join('')}</details>`}</section>
      <details class="saved-plan-history" data-disclosure-key="checkpoint-history"><summary>Checkpoint history · ${plans().length}</summary><p class="small muted">Snapshots of work at the time they were saved. Work above keeps its own identity and status.</p>${plan?`<div class="toolbar"><label class="field-label" for="plan-select">Checkpoint</label><select id="plan-select">${options}</select><button class="text-button" type="button" ${selectionAttr('plan',plan.id)}>Inspect checkpoint</button></div><details class="saved-plan" open><summary>${escape(plan.title)} · ${plan.steps?.length || 0} steps · ${escape(date(plan.at))}</summary><p class="small muted">${plan.scopeId?`Work scope: ${escape(items().find(i=>i.id===plan.scopeId)?.title || plan.scopeId)}`:'Scope was not recorded. Comparisons require shared work IDs.'}</p>${(plan.steps || []).map(step=>node(step,'step',plan.id)).join('')}</details>`:'<p class="small muted">No checkpoints recorded.</p>'}</details>`;
  }

  function filteredEvents() {
    const meaningful=new Set(meaningfulEvents().map(event=>event.id));
    return (data.events || []).filter(event => {
      if (ui.timelineMode==='meaningful' && !ui.kind && !meaningful.has(event.id)) return false;
      if (ui.session && event.sessionId !== ui.session) return false;
      if (ui.actor && event.actor !== ui.actor) return false;
      if (ui.kind && event.kind !== ui.kind) return false;
      if (ui.search && !(event.summary + ' ' + (event.text || '')).toLowerCase().includes(ui.search.toLowerCase())) return false;
      if (ui.saved) {
        const matchingIds = new Set(items().filter(item => ui.saved === 'open' ? !isClosed(item) : needsVerification(item)).flatMap(item => item.sourceIds || []));
        if (!matchingIds.has(event.id)) return false;
      }
      return true;
    }).sort((a,b) => new Date(b.at) - new Date(a.at));
  }
  function timelineView() {
    const matching = filteredEvents();
    const kinds = [...new Set((data.events || []).map(event => event.kind))].filter(Boolean).sort();
    const shown = matching.slice(0,ui.limit);
    let group = '';
    const rows = shown.map(event => {
      const day = date(event.at,{hour:undefined,minute:undefined});
      const heading = group !== day ? `<p class="timeline-group">${escape(day)}</p>` : '';
      group = day;
      const usage=event.kind==='usage.tokens'?event.data?.usage:null;
      const description=usage ? `Input ${tokenNumber(usage.input_tokens,true)} · Output ${tokenNumber(usage.output_tokens,true)} · ${tokenNumber(usage.cached_input_tokens,true)} cached` : event.text && event.text!==event.summary && !event.text.startsWith((event.summary || '').replace(/…$/,'')) ? short(event.text,170) : '';
      return heading + `<button type="button" class="timeline-row" ${selectionAttr('event',event.id)}><span class="event-time">${escape(time(event.at))}<small>${escape(short(event.actor,15))}</small></span><span class="event-body"><span class="event-title">${escape(event.summary || label(event.kind))}</span>${description ? `<span class="event-description">${escape(description)}</span>` : ''}<span class="event-badges">${tag(label(event.kind))}${tag(provenanceLabel(event.provenance),event.provenance==='user'?'active':event.provenance==='inferred'?'warn':'')}${nativeBadges(event)}${event.sessionId && sessions().length > 1 ? tag(sessionTitle(event.sessionId),'tag-outline') : ''}</span></span></button>`;
    }).join('');
    return `<h3>${ui.timelineMode==='meaningful'?'Meaningful changes':'All captured records'}</h3><p class="small muted">${ui.timelineMode==='meaningful'?'User directions, saved plans, decisions and outcomes come first.':'Tool activity and native usage are available here; a tool return alone does not establish progress.'}</p><div class="panel-bar"><span>${matching.length} matching records · newest first</span></div><div class="toolbar"><label class="field-label" for="timeline-mode">Show</label><select id="timeline-mode"><option value="meaningful" ${ui.timelineMode==='meaningful'?'selected':''}>Meaningful changes</option><option value="all" ${ui.timelineMode==='all'?'selected':''}>All captured records</option></select><input id="timeline-search" type="search" aria-label="Search activity" placeholder="Search activity, decisions, and updates" value="${escape(ui.search)}"><select id="kind-filter" aria-label="Activity type"><option value="">${ui.timelineMode==='meaningful'?'Meaningful activity types':'All activity types'}</option>${kinds.map(kind => `<option value="${escape(kind)}" ${kind===ui.kind?'selected':''}>${escape(label(kind))}</option>`).join('')}</select></div>${rows || '<p class="empty">No activity matches this scope. Clear the filters to see the chat record.</p>'}${matching.length > shown.length ? `<button type="button" class="load-more" data-more-events>Show 70 more · ${matching.length - shown.length} remaining</button>` : ''}`;
  }
  function changesView() {
    if (plans().length < 2) return '<p class="empty">A comparison needs two saved plans. Record the next plan revision to see what was added, removed, or retained.</p>';
    const before = baselinePlan(); const after = currentPlan();
    const choices=selected=>`<option value="">Choose a checkpoint</option>${[...plans()].reverse().map(plan=>`<option value="${escape(plan.id)}" ${selected===plan.id?'selected':''}>${escape(plan.title)}</option>`).join('')}`;
    if(!comparable(before,after))return `<h3>Plan changes</h3><div class="comparison-selectors"><label><span class="field-label">Before</span><select id="baseline-plan">${choices(before?.id)}</select></label><label><span class="field-label">After</span><select id="current-plan">${choices(after?.id)}</select></label></div><p class="scope-notice">These checkpoints have different or unknown work scopes. No additions or removals are inferred. Choose two checkpoints of the same work, or with shared work IDs.</p>`;
    const beforeMap = new Map((before.steps || []).map(step => [step.id,step]));
    const afterMap = new Map((after.steps || []).map(step => [step.id,step]));
    const added = [...afterMap.keys()].filter(id => !beforeMap.has(id));
    const removed = [...beforeMap.keys()].filter(id => !afterMap.has(id));
    const retained = [...afterMap.keys()].filter(id => beforeMap.has(id));
    const changed = retained.filter(id => str(beforeMap.get(id).title) !== str(afterMap.get(id).title) || str(beforeMap.get(id).status) !== str(afterMap.get(id).status));
    const options = selected => plans().map(plan => `<option value="${escape(plan.id)}" ${selected===plan.id?'selected':''}>${escape(plan.title)}</option>`).join('');
    const step = (record,kind,peer,planId) => `<button type="button" class="change-step ${kind}" ${selectionAttr('step',record.id,planId)}><span>${kind==='added'?'+ ':kind==='removed'?'− ':''}${escape(record.title)}</span><small>${escape(kind==='added'?'Added':kind==='removed'?'Removed':peer && (peer.title!==record.title || peer.status!==record.status)?'Retained · updated':'Retained')} · ${escape(statusLabel(record))}</small></button>`;
    return `<div class="panel-bar"><span>Plan changes within the same work</span><span>Snapshots of the same work</span></div><div class="comparison-selectors"><label><span class="field-label">Before</span><select id="baseline-plan">${options(before.id)}</select></label><label><span class="field-label">After</span><select id="current-plan">${options(after.id)}</select></label></div><div class="diff-summary">${tag(added.length+' added','active')}${tag(removed.length+' removed',removed.length?'fail':'')}${tag(retained.length+' retained')}${changed.length?tag(changed.length+' updated','warn'):''}</div><div class="comparison"><section><h3 class="compare-title">${escape(before.title)}<small>${escape(date(before.at))}${before.kind==='curated_history'?' · Reconstructed from public messages':''}</small></h3>${(before.steps || []).map(record => step(record,afterMap.has(record.id)?'retained':'removed',afterMap.get(record.id),before.id)).join('')}</section><section><h3 class="compare-title">${escape(after.title)}<small>${escape(date(after.at))}${after.kind==='curated_history'?' · Reconstructed from public messages':''}</small></h3>${(after.steps || []).map(record => step(record,beforeMap.has(record.id)?'retained':'added',beforeMap.get(record.id),after.id)).join('')}</section></div><p class="open-note">Matched by stable step IDs. Retained means a step appears in both versions; it does not establish completion. Removed means absent from the later version, not necessarily abandoned. Some early versions were reconstructed from public messages. Select a step to inspect its sources.</p>`;
  }
  function decisionsView() {
    const matching=decisions().filter(decision=>(!ui.session||!decision.sessionId||decision.sessionId===ui.session)&&(!ui.actor||!decision.owner||decision.owner===ui.actor));
    const historical=matching.filter(d=>/superseded|cancelled|rejected/.test(d.status));
    const proposed=matching.filter(d=>/proposed|suggested/.test(d.status));
    const outcomes=matching.filter(d=>/verified|completed/.test(d.status));
    const current=matching.filter(d=>!historical.includes(d)&&!proposed.includes(d)&&!outcomes.includes(d));
    const row=d=>`<article class="decision"><button type="button" class="decision-button" ${selectionAttr('decision',d.id)}><strong>${escape(d.title)}</strong></button><p>${escape(d.rationale || 'Rationale not recorded.')}</p><div class="decision-meta flex">${tag(statusLabel(d))}<span>${escape(date(d.at))} · ${sourcesFor(d).length} linked sources</span></div>${d.supersededReason?`<p class="small muted">${escape(d.supersededReason)}</p>`:''}</article>`;
    return `<h3>Current decisions and instructions · ${current.length}</h3>${current.slice().reverse().map(row).join('') || '<p class="small muted">No current decisions recorded.</p>'}${proposed.length?`<h3>Proposals · ${proposed.length}</h3>${proposed.slice().reverse().map(row).join('')}`:''}<details data-disclosure-key="decision-history"><summary>Superseded choices and recorded outcomes · ${historical.length+outcomes.length}</summary>${[...historical,...outcomes].reverse().map(row).join('')}</details><p class="open-note">A recorded choice, its implementation, and its checks are different claims. Source labels describe the origin of a record, not independent proof.</p>`;
  }

  function contextView() {
    const selected = new Set(ui.included || []);
    const relevant=new Set((data.overview?.events || []).map(event=>event.id));
    const matching = [...(data.events || [])].reverse().filter(event => {
      if(ui.contextMode!=='all'&&!relevant.has(event.id)&&!selected.has(event.id))return false;
      if (ui.contextSearch && !(event.summary+' '+(event.text || '')+' '+event.id).toLowerCase().includes(ui.contextSearch.toLowerCase())) return false;
      if (ui.session && event.sessionId !== ui.session) return false;
      if (ui.actor && event.actor !== ui.actor) return false;
      return true;
    });
    matching.sort((a,b)=>Number(selected.has(b.id))-Number(selected.has(a.id)));
    const shown = matching.slice(0,ui.contextLimit);
    return `<h3>Sources for your next question</h3><label class="context-mode">Show <select id="context-mode"><option value="relevant" ${ui.contextMode==='relevant'?'selected':''}>Work, decisions and evidence</option><option value="all" ${ui.contextMode==='all'?'selected':''}>All captured records</option></select></label><div class="panel-bar"><span>Choose what Codex should inspect</span>${tag(selected.size+' sources selected','active')}</div><div class="context-goal"><div class="flex"><strong class="small">Latest user direction</strong>${tag('Always included','active')}</div><p>${escape(intentText())}</p></div><div class="context-tools"><input id="context-search" type="search" placeholder="Find source records to include" aria-label="Search context records" value="${escape(ui.contextSearch)}"><button type="button" class="text-button" data-context-clear>Clear selected sources</button><button type="button" class="text-button" data-suggested-sources>Use suggested sources</button><button type="button" class="primary-button" data-context-ask="Where are we with the current plan?">${iconMarkup('message-square-text')}<span>Ask using these sources</span></button></div>${shown.map(event => `<div class="context-row"><input type="checkbox" id="record-${escape(event.id)}" data-context="${escape(event.id)}" ${selected.has(event.id)?'checked':''} aria-label="Include ${escape(short(event.summary,90))}"><div><label class="context-title" for="record-${escape(event.id)}">${escape(event.summary || label(event.kind))}</label><small>${escape(provenanceLabel(event.provenance))} · ${escape(event.actor || 'Not recorded')} · ${escape(date(event.at))}</small><small class="mono">${escape(short(event.id,58))}</small>${event.text ? `<span class="context-text">${escape(short(event.text,300))}</span>` : ''}<button type="button" class="text-button" ${selectionAttr('event',event.id)}>Inspect source ↗</button></div></div>`).join('') || '<p class="empty">No context records match this scope.</p>'}${matching.length > shown.length ? `<button type="button" class="load-more" data-more-context>Show 45 more records · ${matching.length-shown.length} remaining</button>` : ''}<p class="open-note">Checked sources are used in your next question. Inspecting a record does not add it automatically. The latest user direction stays included; new activity does not change your selection.</p>`;
  }
  function sourceLink(source) {
    const ref = str(source?.ref);
    if (/^https?:\/\//i.test(ref)) return `<a href="${escape(ref)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>`;
    if (/^codex:\/\/(threads|review)/.test(ref)) return `<a href="${escape(ref)}">Open in Codex ↗</a>`;
    return escape(ref || 'Source reference unavailable');
  }
  function sourceCard(event) {
    return `<details class="source-card" data-source-id="${escape(event.id)}"><summary><span class="source-summary-copy">${escape(short(event.summary,80))}<span class="muted">${escape(provenanceLabel(event.provenance))} · ${escape(date(event.at))}</span></span></summary><p>${escape(event.text || event.summary || 'No public text recorded.')}</p><div class="source-reference mono">${sourceLink(event.source)}</div><div class="source-reference mono">Record ${escape(event.id)}</div></details>`;
  }
  function requestHistory(requests) {
    if (!requests.length) return '';
    return `<section class="request-history"><p class="inspector-title">Recent questions</p>${requests.map(request => {
      const changed = request.result && request.contextRevision !== undefined && request.contextRevision !== contextRevision(data);
      const revision = request.baselineRevision ?? request.revision;
      return `<details class="request-row" data-request-id="${escape(request.id)}"><summary>${tag(label(request.status || 'Prepared'),tone(request.status))}<span>${escape(short(request.question || request.id,90))}</span></summary><div class="request-content"><p class="field-label">Question</p><p class="request-question">${escape(request.question || request.id)}</p><p class="request-meta">Prepared ${escape(date(request.at))}${revision !== undefined ? ` · Work revision ${escape(revision)}` : ''}</p>${request.error ? `<p class="request-error">${escape(request.error)}</p>` : ''}${request.result ? `<p class="field-label">Answer</p><p class="request-result">${escape(str(request.result))}</p>${changed ? `<p class="request-currency">${tag('Work changed since this answer','warn')}</p>` : ''}${request.updatedAt ? `<p class="request-meta">Answered ${escape(date(request.updatedAt))}</p>` : ''}${request.resultSourceId ? `<button type="button" class="text-button" ${selectionAttr('event',request.resultSourceId)}>Inspect answer source ↗</button>` : ''}` : '<p class="small muted">No answer recorded yet.</p>'}</div></details>`;
    }).join('')}</section>`;
  }
  function renderInspector() {
    const openRequests = new Set([...document.querySelectorAll('details.request-row[open]')].map(detail => detail.dataset.requestId));
    const selected = selectedRecord();
    const record = selected.record;
    const evidence = selected.sources;
    const classes = record.provenance ? [provenanceLabel(record.provenance)] : [...new Set(evidence.map(event => provenanceLabel(event.provenance)))];
    const title = record.title || record.summary || data.project.title;
    const purpose = record.purpose || record.rationale || (selected.kind==='event' ? short(record.text || record.summary,330) : selected.kind==='project' ? data.project.goal : 'Purpose has not been recorded.');
    const requests = [...(data.requests || [])].reverse().slice(0,5);
    $('inspector').hidden=!ui.inspectorOpen;
    $('inspector').innerHTML = `<button type="button" id="inspector-close" class="text-button inspector-close" data-close-inspector aria-label="Close selected work details">Close details ${iconMarkup('x')}</button><section><p class="inspector-title">Selected ${escape(selected.kind==='event'?'activity':selected.kind==='project'?'project':selected.kind==='step'?'plan step':'work')}</p><div class="flex">${tag(label(record.kind || selected.kind))}${classes.length ? tag(classes.join(' + '),classes.includes('Inferred')?'warn':'') : tag('No linked evidence','warn')}</div><h2>${escape(title)}</h2><p class="purpose">${escape(purpose)}</p>${selected.kind==='item' && isReview(record) ? `<section class="review-actions"><h3>Review this work</h3><p class="small muted">Record your decision here. This updates Flux; it does not send instructions to Codex.</p><label class="field-label" for="review-note">Note (optional)</label><textarea id="review-note" rows="3" maxlength="2000">${escape(ui.reviewNote)}</textarea><div class="review-buttons"><button type="button" class="primary-button" data-review-outcome="accepted" ${reviewBusy?'disabled':''}>${iconMarkup('check')}<span>Accept work</span></button><button type="button" class="secondary-button" data-review-outcome="changes_requested" ${reviewBusy?'disabled':''}>${iconMarkup('message-square-text')}<span>Needs changes</span></button></div><p id="review-feedback" class="small" role="status"></p></section>` : record.review ? `<section class="review-actions"><h3>${escape(statusLabel(record))}</h3><p>${escape(record.review.note || 'No review note added.')}</p><p class="small muted">Reviewed ${escape(date(record.review.at))}</p></section>` : ''}<dl class="fields">${nativeFields(record)}${selected.plan ? `<div><dt>Saved plan</dt><dd>${escape(selected.plan.title)}<span class="plan-version">${escape(selected.plan.id)} · ${escape(date(selected.plan.at))}</span></dd></div>` : ''}${record.status ? `<div><dt>${selected.plan ? 'State in that plan' : 'Recorded status'}</dt><dd>${tag(statusLabel(record),tone(record.status))}</dd></div>` : ''}<div><dt>Who / where</dt><dd>${escape(record.owner || record.actor || 'Codex')} / ${escape(sessionTitle(record.sessionId || data.project.sessionId))}</dd></div>${record.returnCondition ? `<div><dt>When to return</dt><dd>${escape(record.returnCondition)}</dd></div>` : selected.kind==='item' && record.parentId ? '<div><dt>When to return</dt><dd>Not recorded. Ask Codex where this branch reconnects.</dd></div>' : ''}${record.at ? `<div><dt>Recorded</dt><dd>${escape(date(record.at))}</dd></div>` : ''}<div><dt>Sources · ${evidence.length}</dt><dd>${evidence.length ? evidence.map(sourceCard).join('') : 'No public source is linked to this record.'}</dd></div></dl></section><section class="ask-section"><h3>Ask about this work</h3><label class="field-label" for="question">Question</label><select id="question">${questions.map(question => `<option ${question===ui.question?'selected':''}>${escape(question)}</option>`).join('')}</select><button type="button" class="primary-button" id="preview-question" ${processing?'disabled':''}>${iconMarkup('message-square-text')}<span>Review question and sources</span></button><p class="ask-note">${ui.included?.length || 0} selected sources + latest user direction.<br>Review first, then send to this chat. Answers are limited to 200 words.</p><button type="button" class="text-button" data-tab="Context">${iconMarkup('files')}<span>Choose question sources</span></button><button type="button" class="text-button" data-context-sources>Include this work’s sources</button></section>${requestHistory(requests)}`;
    document.querySelectorAll('details.request-row').forEach(detail => {detail.open=openRequests.has(detail.dataset.requestId);});
    enhanceDisclosureSummaries($('inspector'));
  }
  function planCurrency() {
    const plan = currentPlan();
    if (!plan || !['Plan','Changes'].includes(ui.tab)) return '';
    if (ui.followLatest) return `<div class="plan-currency">${tag('Following latest saved plan','active')}</div>`;
    const newer = plan.id !== latestPlan()?.id;
    return `<div class="plan-currency">${tag(newer ? 'Newer plan available' : 'Saved plan pinned',newer ? 'warn' : '')}<button class="text-button" type="button" data-use-latest>Use latest plan →</button></div>`;
  }
  function renderPanel() {
    $('work-view').setAttribute('aria-labelledby','tab-'+ui.tab.toLowerCase());
    $('work-view').innerHTML = (!data.runtime || data.runtime.restartRequired ? '<p class="runtime-warning" role="alert">The Flux service needs a restart to use the current work model. Displayed records may be out of date.</p>' : '') + (ui.tab==='Overview'?'':`<div class="scope-line">${escape(scopeName())}</div>`) + planCurrency() + ({Overview:overviewView,Plan:planView,Timeline:timelineView,Changes:changesView,Decisions:decisionsView,Context:contextView}[ui.tab])();
    enhanceDisclosureSummaries($('work-view'));
  }
  function render() {
    if (!data) return;
    const focusId=document.activeElement?.id;
    const focused=document.activeElement;
    const caret=focused && ['INPUT','TEXTAREA'].includes(focused.tagName) ? focused.selectionStart : null;
    const openSources=new Set([...document.querySelectorAll('details.source-card[open]')].map(detail => detail.dataset.sourceId));
    const savedPlanOpen=document.querySelector('details.saved-plan')?.open;
    const openOverviewDetails=new Map([...document.querySelectorAll('details.overview-settled,details.overview-source,details[data-disclosure-key]')].map(detail=>[detail.dataset.disclosureKey || detail.querySelector('summary')?.textContent,detail.open]));
    $('project-name').textContent = data.project.title;
    $('app').classList.toggle('named-project',!/^(Decantr\s+)?Flux$/i.test(data.project.title || ''));
    $('goal').textContent = data.project.goal || data.project.title;
    $('goal-detail').textContent = data.project.description || '';
    $('app').classList.toggle('scope-open',ui.scopeOpen);
    document.querySelector('.shell').classList.toggle('has-inspector',ui.inspectorOpen);
    $('sidebar').hidden=!ui.scopeOpen;
    $('scope-toggle').setAttribute('aria-expanded',String(ui.scopeOpen));
    document.title = 'Flux · ' + data.project.title;
    $('tabs').querySelectorAll('[data-tab]').forEach(button => {const active=button.dataset.tab===ui.tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    renderSidebar(); renderPanel(); renderInspector(); enhanceDisclosureSummaries(document);
    document.querySelectorAll('details.overview-settled,details.overview-source,details[data-disclosure-key]').forEach(detail=>{const key=detail.dataset.disclosureKey || detail.querySelector('summary')?.textContent;if(openOverviewDetails.has(key))detail.open=openOverviewDetails.get(key);});
    document.querySelectorAll('details.source-card').forEach(detail => {detail.open=openSources.has(detail.dataset.sourceId);});
    if (savedPlanOpen!==undefined && document.querySelector('details.saved-plan')) document.querySelector('details.saved-plan').open=savedPlanOpen;
    const nextFocused=focusId?$(focusId):null;
    if (nextFocused && nextFocused!==focused) {nextFocused.focus({preventScroll:true});if(caret!==null && typeof nextFocused.setSelectionRange==='function') nextFocused.setSelectionRange(caret,caret);}
    $('coverage').textContent = coverageDescription();

    $('last-update').textContent = data.coverage?.lastImportedAt ? 'Chat captured '+date(data.coverage.lastImportedAt) : 'Chat capture time unknown';
    updateConnection();
    const latestRequest=prepared && (data.requests || []).find(request=>request.id===prepared.id);
    if($('diagnostic-dialog').open && latestRequest && (latestRequest.status!==prepared.status || latestRequest.result!==prepared.result)){
      prepared={...prepared,...latestRequest};showPrepared(prepared);
    }
    if ($('diagnostic-dialog').open && prepared && contextRevision(prepared) !== contextRevision(data) && prepared.status==='prepared') {
      setCallout('The plan or latest user direction changed after this preview. Review the latest context, then prepare the question again.','warn');
      setButtonLabel('queue-prompt','Refresh and prepare again','refresh-cw');
      $('queue-prompt').disabled = false;
    }
  }
  function updateConnection() {
    const sources=[data?.project?.clientName,data?.project?.client?.name,data?.project?.client,data?.coverage?.clientName,data?.coverage?.client?.name,data?.coverage?.client];
    const declared=sources.find(value=>typeof value==='string'&&value.trim());
    const adapter=str(data?.coverage?.adapter).trim().toLowerCase();
    const client=declared?.trim() || (adapter==='local transcript'?'Codex':'Flux');
    const capture=data?.coverage?.status;
    const message=streamConnected?(capture==='unavailable'?'Chat capture unavailable':client==='Flux'?'Connected to Flux':`Reading ${client} chat`):data?'Reconnecting to Flux':'Connecting to Flux';
    setConnectionState(message,streamConnected,client);
  }
  function setConnectionState(message,connected=false,compact='Flux') {
    const node=$('connection');
    node.textContent=message;
    node.setAttribute('aria-label',message);
    node.setAttribute('data-compact',compact);
    node.setAttribute('title','Local Flux connection and chat capture only. Client execution health is not measured.');
    node.className='connection'+(connected?' connected':'');
  }
  async function refresh() {
    if (loading) {loadingAgain=true; return;}
    loading=true;
    try {
      const response = await fetch('/api/state',{cache:'no-store'});
      if (!response.ok) throw new Error('The local service returned '+response.status+'.');
      const next = await response.json();
      if (!next.project || !Array.isArray(next.events)) throw new Error('The service returned an incomplete work record.');
      const initial=!data;
      data=next;
      if (initial) restorePreferences();
      if (ui.followLatest || !plans().some(plan => plan.id===ui.current)) ui.current=latestPlan()?.id || '';
      if (!plans().some(plan => plan.id===ui.baseline)) ui.baseline='';
      initializeContext();
      render();
      if (!stream) connectStream();
    } catch (error) {
      if (!data) {
        setConnectionState('Flux service unavailable',false,'Unavailable');
        $('work-view').innerHTML=`<div class="error-banner" role="alert">${iconMarkup('circle-x','error-icon')}<span>Could not load the work record. ${escape(error.message)}<br>Use Refresh after starting the local Flux service.</span></div>`;
        renderIcons($('work-view'));
      } else {
        setConnectionState('Flux display error',false,'Error');
        if ($('work-view').textContent.includes('Loading the local record')) {
          $('work-view').innerHTML=`<div class="error-banner" role="alert">${iconMarkup('circle-x','error-icon')}<span>Flux received the work record but could not render it: ${escape(error.message)}. Reload this page and share this notice with Codex if it continues.</span></div>`;
          renderIcons($('work-view'));
        }
      }
      announce(error.message);
    } finally {loading=false;if(loadingAgain){loadingAgain=false;void refresh();}}
  }
  function connectStream() {
    if (!window.EventSource) return;
    stream=new EventSource('/api/events');
    stream.onopen=() => {streamConnected=true;updateConnection();void refresh();};
    stream.onerror=() => {streamConnected=false;updateConnection();};
    stream.addEventListener('update',() => void refresh());
  }
  async function postDiagnostic(body) {
    const response=await fetch('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json','X-Flux-CSRF':data.csrfToken},body:JSON.stringify(body)});
    const result=await response.json().catch(() => ({}));
    if (!response.ok) {const error=new Error(result.error || 'The diagnostic request failed ('+response.status+').');error.status=response.status;throw error;}
    return result;
  }
  function diagnosticBody() {
    const selected=selectedRecord();
    const reference=selected.kind==='step' ? `step reference ${selected.record.id} in saved plan reference ${selected.plan.id}` : `${selected.kind} reference ${selected.record.id}`;
    const question=ui.question+(selected.kind!=='item' && selected.kind!=='project'?`\nFocus on ${reference}. Use only included evidence; if this reference is excluded, identify the gap.`:'');
    return {question,selectedItemId:selected.kind==='item'?selected.record.id:undefined,recordIds:[...(ui.included || [])],baselinePlanId:selected.kind==='step'?selected.plan.id:selected.kind==='plan'?selected.record.id:ui.question==='Audit progress since the last saved plan'?latestPlan()?.id:undefined,expectedRevision:contextRevision(data),dispatch:false};
  }
  function showPrepared(result) {
    $('diagnostic-title').textContent=result.status==='completed'?'Answer from Codex':'Review and send';
    const locked=['queued','acknowledged','completed'].includes(result.status);
    $('composer-fields').hidden=false;
    $('composer-question').value=(result.question || ui.question).split('\nFocus on ')[0];
    $('composer-question').disabled=locked;
    $('composer-scope').textContent='About: '+composerScope+' · Destination: this chat';
    $('composer-count').textContent='· '+(result.recordIds?.length || 0);
    const selectedIds=new Set(result.recordIds || []);
    $('composer-sources').innerHTML=composerCandidates.map(id=>eventMap().get(id)).filter(Boolean).map(record=>`<label class="composer-source"><input type="checkbox" data-composer-source="${escape(record.id)}" ${selectedIds.has(record.id)?'checked':''} ${locked?'disabled':''}><span>${escape(short(record.summary || record.text || record.id,160))}<small>${escape(provenanceLabel(record.provenance))} · ${escape(date(record.at))}</small></span></label>`).join('') || '<p class="small muted">No extra sources selected. Close this dialog and use Context to choose records.</p>';
    composerDirty=false;
    $('diagnostic-description').textContent=(result.recordIds?.length || 0)+' selected sources, plus your latest direction and the project goal.'+(result.omittedRecordCount ? ' '+result.omittedRecordCount+' sources do not fit the context budget. Remove less relevant sources or narrow the question. See the exact prompt below.' : '');
    $('diagnostic-prompt').value=result.prompt || '';
    setCallout(result.error || ({queued:'Accepted by Codex’s queue. Waiting for receipt or an answer.',acknowledged:'Codex received the question. Waiting for an answer.',completed:'The answer has been recorded.'}[result.status] || 'Prepared for review. This question checks the record; it does not authorize changing the plan or executing recommendations.'),result.status==='queued'?'active':result.status==='failed'?'fail':'');
    const buttonLabel=result.status==='completed'?['Answered','circle-check-big']:['queued','acknowledged'].includes(result.status)?['Waiting for an answer','clock-3']:result.status==='failed'?['Review again','refresh-cw']:['Send to Codex','send'];
    setButtonLabel('queue-prompt',buttonLabel[0],buttonLabel[1]);
    $('queue-prompt').disabled=['queued','acknowledged','completed'].includes(result.status);
    $('diagnostic-answer').hidden=result.status!=='completed';
    $('diagnostic-answer-text').textContent=result.result || '';
    if (!$('diagnostic-dialog').open) $('diagnostic-dialog').showModal();
  }
  async function previewQuestion() {
    if (processing || !data) return;
    processing=true;renderInspector();
    const selection=selectedRecord();
    composerScope=selection.record.title || selection.record.summary || data.project.title;
    composerCandidates=[...new Set([...(ui.included || []),...suggestedSources()])];
    preparedBody=diagnosticBody();
    try {prepared=await postDiagnostic(preparedBody);showPrepared(prepared);await refresh();}
    catch (error) {
      if (error.status===409) {await refresh();announce('The work record changed. Review it and preview your question again.');}
      $('diagnostic-title').textContent='Question could not be prepared';
      $('diagnostic-description').textContent='The question has not been queued.';
      setCallout(error.status===409?'New activity arrived while preparing. Close this preview, review the latest records, and try again.':error.message,'fail');
      $('diagnostic-prompt').value='';
      $('composer-fields').hidden=true;
      prepared=null;$('queue-prompt').disabled=true;
      if (!$('diagnostic-dialog').open) $('diagnostic-dialog').showModal();
    } finally {processing=false;renderInspector();}
  }
  async function queueQuestion() {
    if (processing || !prepared || !preparedBody) return;
    if(prepared.status==='completed' || ['queued','acknowledged'].includes(prepared.status))return;
    if(composerDirty || prepared.status==='failed'){await previewQuestion();return;}
    if (contextRevision(prepared)!==contextRevision(data)) {await refresh();await previewQuestion();return;}
    processing=true;$('queue-prompt').disabled=true;
    try {
      const result=await postDiagnostic({...preparedBody,requestId:prepared.id,expectedRevision:contextRevision(prepared),dispatch:true});
      prepared=result;showPrepared(result);await refresh();
      announce(result.status==='queued'?'Question queued to this chat.':result.error || 'Question could not be queued.');
    } catch (error) {
      if (error.status===409) {
        await refresh();
        setCallout('The plan or record changed before dispatch. Refresh and prepare again before queueing.','warn');
        setButtonLabel('queue-prompt','Refresh and prepare again','refresh-cw');
      } else {
        setCallout('Queue failed. '+error.message+' You can copy the prepared prompt into this chat.','fail');
      }
      $('queue-prompt').disabled=false;
    } finally {processing=false;}
  }
  function markComposerDirty() {
    composerDirty=true;
    setButtonLabel('queue-prompt','Update preview','refresh-cw');
    $('queue-prompt').disabled=!ui.question.trim();
    setCallout('Your question or sources changed. Update the preview before sending.','warn');
  }
  async function submitReview(outcome) {
    if(reviewBusy)return;
    const selected=selectedRecord();
    if(selected.kind!=='item' || !isReview(selected.record))return;
    reviewBusy=true;
    const body={itemId:selected.record.id,outcome,note:ui.reviewNote,expectedRevision:contextRevision(data)};
    renderInspector();
    try {
      const response=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json','X-Flux-CSRF':data.csrfToken},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error || 'Review could not be recorded.');
      ui.reviewNote='';
      await refresh();
      announce(outcome==='accepted'?'Work accepted in Flux.':'Work marked as needing changes in Flux.');
    } catch(error) {
      announce(error.message);
      const feedback=$('review-feedback');if(feedback)feedback.textContent=error.message;
    } finally {reviewBusy=false;document.querySelectorAll('[data-review-outcome]').forEach(button=>{button.disabled=false;});}
  }
  async function copyPrompt() {
    const field=$('diagnostic-prompt');
    if (!field.value) return;
    try {await navigator.clipboard.writeText(field.value);setButtonLabel('copy-prompt','Copied','circle-check-big');announce('Prompt copied.');setTimeout(() => setButtonLabel('copy-prompt','Copy prompt','copy'),1500);}
    catch {field.focus();field.select();setCallout('The prompt is selected. Press Command+C or Control+C to copy it, then paste it into this chat.');}
  }
  function renderSearchPreservingFocus(id) {
    const field=$(id);const position=field?.selectionStart;
    renderPanel();const next=$(id);next?.focus();if(next && position!==null) next.setSelectionRange(position,position);
  }
  document.addEventListener('click',event => {
    const button=event.target.closest('button');
    if (!button) return;
    let restoreFocus = null;
    if (button.id==='refresh') {void refresh();return;}
    if (button.hasAttribute('data-close-dialog')) {$('diagnostic-dialog').close();return;}
    if (button.id==='copy-prompt') {void copyPrompt();return;}
    if (button.id==='queue-prompt') {void queueQuestion();return;}
    if (!data) return;
    if (button.id==='preview-question') {void previewQuestion();return;}
    if(button.dataset.reviewOutcome){void submitReview(button.dataset.reviewOutcome);return;}
    if (button.id==='scope-toggle') {ui.scopeOpen=!ui.scopeOpen;if(ui.scopeOpen&&isNarrowViewport())ui.inspectorOpen=false;}
    else if (button.id==='scope-close') {ui.scopeOpen=false;restoreFocus='scope-toggle';}
    else if (button.hasAttribute('data-close-inspector')) {ui.inspectorOpen=false;restoreFocus='selected';}
    else if (button.dataset.overviewAsk || button.dataset.contextAsk) {ui.selected={type:'project',id:data.project.id};ui.question=button.dataset.overviewAsk || button.dataset.contextAsk;if(button.dataset.overviewAsk)ui.included=suggestedSources();ui.inspectorOpen=false;ui.scopeOpen=false;render();void previewQuestion();return;}
    else if(button.dataset.planView){ui.planView=button.dataset.planView;}
    else if (button.dataset.tab) {ui.tab=button.dataset.tab;ui.inspectorOpen=false;if(isNarrowViewport())ui.scopeOpen=false;}
    else if (button.dataset.select) {ui.selected={type:button.dataset.selectType,id:button.dataset.select,...(button.dataset.selectPlan ? {planId:button.dataset.selectPlan} : {})};ui.reviewNote='';if(ui.tab!=='Context' && ui.selected.type!=='event')ui.included=suggestedSources();ui.inspectorOpen=true;if(isNarrowViewport()){ui.scopeOpen=false;restoreFocus='inspector-close';}}
    else if (button.hasAttribute('data-use-latest')) {ui.followLatest=true;ui.current=latestPlan()?.id || '';}
    else if (button.hasAttribute('data-project-reset')) {ui.session='';ui.actor='';ui.saved='';}
    else if (button.hasAttribute('data-session')) {ui.session=button.dataset.session;ui.saved='';if(ui.tab==='Overview')ui.tab='Timeline';}
    else if (button.hasAttribute('data-actor')) {ui.actor=button.dataset.actor;ui.saved='';ui.tab='Timeline';}
    else if (button.dataset.saved) {ui.saved=ui.saved===button.dataset.saved?'':button.dataset.saved;ui.tab='Plan';}
    else if (button.hasAttribute('data-more-events')) {ui.limit+=70;}
    else if (button.hasAttribute('data-more-context')) {ui.contextLimit+=45;}
    else if (button.hasAttribute('data-context-clear')) {ui.included=[];}
    else if (button.hasAttribute('data-suggested-sources')) {ui.selected={type:'project',id:data.project.id};ui.included=suggestedSources();}
    else if (button.hasAttribute('data-context-sources')) {ui.included=[...new Set([...ui.included,...selectedRecord().sources.map(record => record.id)])];announce('Selected source records included.');}
    else return;
    render();savePreferences();
    if(restoreFocus==='scope-toggle')$('#scope-toggle')?.focus({preventScroll:true});
    if(restoreFocus==='inspector-close')$('#inspector-close')?.focus({preventScroll:true});
    if(restoreFocus==='selected'){
      const trigger=[...document.querySelectorAll('[data-select]')].find(node=>node.dataset.select===ui.selected.id&&node.dataset.selectType===ui.selected.type);
      (trigger||$('#tab-'+ui.tab.toLowerCase()))?.focus({preventScroll:true});
    }
  });
  document.addEventListener('change',event => {
    if (!data) return;
    const target=event.target;
    if (target.dataset.composerSource) {ui.included=target.checked?[...new Set([...ui.included,target.dataset.composerSource])]:ui.included.filter(id=>id!==target.dataset.composerSource);$('composer-count').textContent='· '+ui.included.length;markComposerDirty();return;}
    if (target.id==='question') ui.question=target.value;
    else if (target.id==='context-mode') {ui.contextMode=target.value;ui.contextLimit=45;}
    else if (target.id==='kind-filter') {ui.kind=target.value;if(ui.kind)ui.timelineMode='all';ui.limit=70;}
    else if (target.id==='timeline-mode') {ui.timelineMode=target.value;ui.kind='';ui.limit=70;}
    else if (target.id==='baseline-plan') ui.baseline=target.value;
    else if (target.id==='current-plan' || target.id==='plan-select') {ui.current=target.value;ui.followLatest=false;}
    else if (target.dataset.context) {
      ui.included=target.checked?[...new Set([...ui.included,target.dataset.context])]:ui.included.filter(id => id!==target.dataset.context);
      render();savePreferences();return;
    } else return;
    render();savePreferences();
  });
  document.addEventListener('input',event => {
    if(event.target.id==='composer-question'){ui.question=event.target.value;markComposerDirty();return;}
    if(event.target.id==='review-note'){ui.reviewNote=event.target.value;return;}
    if (event.target.id==='timeline-search') {ui.search=event.target.value;ui.limit=70;renderSearchPreservingFocus('timeline-search');}
    if (event.target.id==='context-search') {ui.contextSearch=event.target.value;ui.contextLimit=45;renderSearchPreservingFocus('context-search');}
  });
  $('tabs').addEventListener('keydown',event => {
    const index=tabs.indexOf(ui.tab);
    let next;
    if (event.key==='ArrowRight') next=(index+1)%tabs.length;
    if (event.key==='ArrowLeft') next=(index+tabs.length-1)%tabs.length;
    if (event.key==='Home') next=0;
    if (event.key==='End') next=tabs.length-1;
    if (next!==undefined) {event.preventDefault();ui.tab=tabs[next];ui.inspectorOpen=false;render();$('tab-'+ui.tab.toLowerCase()).focus();savePreferences();}
  });
  window.addEventListener('keydown',event => {
    if(event.key==='Escape'&&!$('diagnostic-dialog').open&&(ui.inspectorOpen||ui.scopeOpen)){
      event.preventDefault();
      const restore=ui.inspectorOpen?'selected':'scope-toggle';
      ui.inspectorOpen=false;ui.scopeOpen=false;render();savePreferences();
      if(restore==='scope-toggle')$('#scope-toggle')?.focus({preventScroll:true});
      else{
        const trigger=[...document.querySelectorAll('[data-select]')].find(node=>node.dataset.select===ui.selected.id&&node.dataset.selectType===ui.selected.type);
        (trigger||$('#tab-'+ui.tab.toLowerCase()))?.focus({preventScroll:true});
      }
      return;
    }
    if ((event.metaKey||event.ctrlKey) && event.key==='/' && data) {event.preventDefault();ui.tab='Timeline';render();$('timeline-search').focus();}
  });
  window.addEventListener('beforeunload',() => stream?.close());
  void refresh();
})();
