try{
  const __boot=document.getElementById('storageBootStatus');
  if(__boot)__boot.textContent+=' / JS実行開始';
}catch{}
const STORE_KEY='smartScheduleDataV1';
const BACKUP_KEY='smartScheduleDataBackupV1';
const HISTORY_KEY='smartScheduleHistoryV1';
const SAFETY_MARKER_KEY='smartScheduleHasDataEverV1';
const BACKUP_HISTORY_LIMIT=7;
let persistenceLocked=false;
let loadSafetyReason='';
const WEEKDAYS=['日','月','火','水','木','金','土'];
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const pad=n=>String(n).padStart(2,'0');
const toDateKey=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const todayKey=()=>toDateKey(new Date());
const minutesToTime=m=>pad(Math.floor(m/60))+':'+pad(m%60);
const timeToMinutes=t=>{const [h,m]=(t||'00:00').split(':').map(Number);return h*60+m};
const fmtMin=m=>m>=60?(Math.floor(m/60)+'時間'+(m%60?m%60+'分':'')):m+'分';
const uuid=()=>crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random();

const defaultState={
  tasks:[],
  settings:{weekdayStart:'16:00',weekdayEnd:'23:00',weekendStart:'09:00',weekendEnd:'23:00',defaultMinChunk:30},
  completionLog:{},
  manualPlacements:{},
  completedTimeline:{},
  memoNotes:[]
};
let state=load();
let todaySchedule=[];

function repairLegacyDurationMismatch(){
  let changed=false;
  for(const t of validTasks()){
    if(t.status==='done')continue;
    const d=Number(t.duration||0);
    const r=Number(t.remainingMinutes??d);
    if(d>0 && r>0 && r<d && !(t.partialProgress===true)){
      t.remainingMinutes=d;
      changed=true;
    }
  }
  if(changed)save();
}
repairLegacyDurationMismatch();

function parseStoredJson(raw){
  if(!raw)return null;
  try{
    const p=JSON.parse(raw);
    return p&&typeof p==='object'?p:null;
  }catch{
    return null;
  }
}

function stateScore(p){
  if(!p||typeof p!=='object')return 0;
  const tasks=Array.isArray(p.tasks)?p.tasks.length:0;
  const memos=Array.isArray(p.memoNotes)?p.memoNotes.length:0;
  return tasks+memos;
}

function readBackupHistory(){
  const raw=parseStoredJson(localStorage.getItem(HISTORY_KEY));
  if(!Array.isArray(raw))return [];
  return raw.filter(x=>x&&typeof x==='object'&&x.data&&typeof x.data==='object');
}

function writeBackupHistory(history){
  try{
    localStorage.setItem(HISTORY_KEY,JSON.stringify(history.slice(0,BACKUP_HISTORY_LIMIT)));
  }catch(err){
    console.warn('Backup history write failed',err);
  }
}

function pushHistorySnapshot(raw,parsed){
  if(!raw||stateScore(parsed)<=0)return;
  const history=readBackupHistory();
  const now=Date.now();
  const latest=history[0];
  const latestTime=latest?.savedAt?new Date(latest.savedAt).getTime():0;

  // Frequent drag/resize saves should not crowd out useful older recovery points.
  if(latest && Number.isFinite(latestTime) && now-latestTime<10*60*1000)return;

  history.unshift({
    savedAt:new Date(now).toISOString(),
    data:parsed
  });
  writeBackupHistory(history);
}

function normalizeLoadedState(raw){
  raw=raw&&typeof raw==='object'?raw:{};
  return {
    tasks:Array.isArray(raw.tasks)?raw.tasks:[],
    settings:{...defaultState.settings,...(raw.settings||{})},
    completionLog:raw.completionLog&&typeof raw.completionLog==='object'?raw.completionLog:{},
    manualPlacements:raw.manualPlacements&&typeof raw.manualPlacements==='object'?raw.manualPlacements:{},
    completedTimeline:raw.completedTimeline&&typeof raw.completedTimeline==='object'?raw.completedTimeline:{},
    memoNotes:Array.isArray(raw.memoNotes)?raw.memoNotes:[]
  };
}

function load(){
  const mainRaw=localStorage.getItem(STORE_KEY);
  const backupRaw=localStorage.getItem(BACKUP_KEY);
  const mainParsed=parseStoredJson(mainRaw);
  const backupParsed=parseStoredJson(backupRaw);
  const history=readBackupHistory();
  const hadDataBefore=localStorage.getItem(SAFETY_MARKER_KEY)==='1';

  let chosen=mainParsed;
  const mainScore=stateScore(mainParsed);

  // A valid non-empty main state always wins. Old backups must never resurrect
  // intentionally deleted tasks merely because they contain more records.
  if(!mainParsed || (mainScore===0 && hadDataBefore)){
    const candidates=[];
    if(stateScore(backupParsed)>0)candidates.push({source:'直前バックアップ',data:backupParsed,raw:backupRaw,savedAt:''});
    for(const item of history){
      if(stateScore(item.data)>0)candidates.push({source:'履歴バックアップ',data:item.data,raw:JSON.stringify(item.data),savedAt:item.savedAt||''});
    }

    candidates.sort((a,b)=>{
      const at=a.savedAt?new Date(a.savedAt).getTime():Number.MAX_SAFE_INTEGER;
      const bt=b.savedAt?new Date(b.savedAt).getTime():Number.MAX_SAFE_INTEGER;
      return bt-at;
    });

    const recovered=candidates[0];
    if(recovered){
      chosen=recovered.data;
      try{localStorage.setItem(STORE_KEY,JSON.stringify(chosen));}catch{}
      loadSafetyReason='保存データの異常を検知し、'+recovered.source+'から自動復旧しました。';
    }else if(hadDataBefore){
      chosen=mainParsed||{};
      persistenceLocked=true;
      loadSafetyReason='以前のデータがある端末で0件状態を検知したため、自動保存を停止しました。';
    }
  }

  const normalized=normalizeLoadedState(chosen||{});
  if(stateScore(normalized)>0){
    try{localStorage.setItem(SAFETY_MARKER_KEY,'1');}catch{}
  }
  return normalized;
}

function save(options={}){
  const force=options.force===true;
  const currentRaw=localStorage.getItem(STORE_KEY);
  const currentParsed=parseStoredJson(currentRaw);
  const currentScore=stateScore(currentParsed);
  const nextScore=stateScore(state);

  if(persistenceLocked && !force){
    console.error('Persistence is safety-locked; write blocked.');
    return false;
  }

  // Never let a transient render/load failure replace real data with an empty state.
  if(!force && currentScore>0 && nextScore===0){
    persistenceLocked=true;
    loadSafetyReason='0件状態による上書きを防止したため、自動保存を停止しました。';
    renderDataSafetyNotice?.();
    console.error('Blocked unsafe empty-state overwrite');
    return false;
  }

  if(currentRaw && currentScore>0){
    try{
      localStorage.setItem(BACKUP_KEY,currentRaw);
      pushHistorySnapshot(currentRaw,currentParsed);
      localStorage.setItem(SAFETY_MARKER_KEY,'1');
    }catch(err){
      console.warn('Backup write failed',err);
    }
  }

  try{
    localStorage.setItem(STORE_KEY,JSON.stringify(state));
    if(nextScore>0)localStorage.setItem(SAFETY_MARKER_KEY,'1');
    return true;
  }catch(err){
    console.error('Main data save failed',err);
    return false;
  }
}

function validTasks(){
  return Array.isArray(state.tasks)?state.tasks.filter(t=>t&&typeof t==='object'&&typeof t.id==='string'): [];
}
function validMemos(){
  return Array.isArray(state.memoNotes)?state.memoNotes.filter(n=>n&&typeof n==='object'&&typeof n.id==='string'): [];
}
function parseDate(v){return v?new Date(v):null}
function daysBetween(a,b){
  const x=new Date(a);x.setHours(0,0,0,0); const y=new Date(b);y.setHours(0,0,0,0);
  return Math.floor((y-x)/86400000);
}
function dateInRange(k,a,b){return (!a||k>=a)&&(!b||k<=b)}
function isRecurringOn(task,date){
  const r=task.recurrence||'none'; if(r==='none') return true;
  const day=date.getDay();
  if(r==='daily') return true;
  if(r==='weekdays') return day>=1&&day<=5;
  if(r==='weekends') return day===0||day===6;
  if(r==='weekly') return (task.weekdays||[]).includes(day);
  return true;
}
function isDoneToday(task,k=todayKey()){return (task.completionDates||[]).includes(k)}

function hasProgressToday(task,k=todayKey()){
  return (task?.progressDates||[]).includes(k);
}
function isCompleted(task){
  if(task.recurrence&&task.recurrence!=='none') return false;
  return task.remainingMinutes<=0 || task.status==='done';
}
function taskCarryoverDueKey(task){
  if(task.recurrence&&task.recurrence!=='none')return '';
  if(task.mode==='date')return task.startDate||'';
  if(task.mode==='range')return task.endDate||'';
  return '';
}

function taskIsOverdue(task,k=todayKey()){
  if(isCompleted(task))return false;
  const due=taskCarryoverDueKey(task);
  return !!due && k>due;
}

function taskOverdueDays(task,k=todayKey()){
  const due=taskCarryoverDueKey(task);
  if(!due)return 0;
  return Math.max(0,daysBetween(due,k));
}

function taskOverdueDetail(task,k=todayKey()){
  const due=taskCarryoverDueKey(task);
  if(!due||!taskIsOverdue(task,k))return '';
  const days=taskOverdueDays(task,k);
  return '期限：'+due.replaceAll('-','/')+' ・ '+days+'日超過 ・ 残り '+fmtMin(task.remainingMinutes??task.duration);
}

function taskActiveOn(task,k=todayKey()){
  if(isCompleted(task)||!isRecurringOn(task,new Date(k+'T12:00:00'))) return false;
  if(task.recurrence!=='none' && isDoneToday(task,k)) return false;

  if(task.recurrence&&task.recurrence!=='none'){
    if(task.startDate&&k<task.startDate)return false;
    if(task.mode==='range')return dateInRange(k,task.startDate,task.endDate);
    return true;
  }

  if(task.mode==='fixed') return task.startDate===k;
  if(task.mode==='date') return !!task.startDate && k>=task.startDate;
  if(task.mode==='range') return (!task.startDate||k>=task.startDate);
  if(task.mode==='auto') {
    if(task.startDate&&k<task.startDate) return false;
    if(task.deadline&&k>task.deadline.slice(0,10)) return true;
    return true;
  }
  return true;
}
function availableDays(task,fromKey=todayKey()){
  let end=task.endDate || (task.deadline?task.deadline.slice(0,10):fromKey);
  if(end<fromKey) return 1;
  let n=0,d=new Date(fromKey+'T12:00:00'),limit=0;
  while(toDateKey(d)<=end&&limit<366){
    if(isRecurringOn(task,d)) n++;
    d.setDate(d.getDate()+1);limit++;
  }
  return Math.max(1,n);
}
const DAILY_WORKLOAD_ALERT_MINUTES=20;

function taskDeadlineKey(task){
  if(task.deadline)return task.deadline.slice(0,10);
  if(task.endDate)return task.endDate;
  return '';
}

function deadlineDaysLeft(task,k=todayKey()){
  const end=taskDeadlineKey(task);
  if(!end)return null;
  return daysBetween(k,end);
}

function deadlineLabel(task,k=todayKey()){
  const d=deadlineDaysLeft(task,k);
  if(d===null)return '';
  if(d<0)return Math.abs(d)+'日超過';
  if(d===0)return '今日締切';
  if(d===1)return '明日締切';
  return 'あと'+d+'日';
}

function deadlineClass(task,k=todayKey()){
  const d=deadlineDaysLeft(task,k);
  if(d===null)return '';
  if(d<=0)return 'deadline-now';
  if(d<=2)return 'deadline-danger';
  if(d<=7)return 'deadline-soon';
  return 'deadline-normal';
}

function minimumLeadDays(minutes){
  const m=Math.max(0,Number(minutes||0));
  if(m<=30)return 3;
  if(m<=60)return 4;
  if(m<=120)return 5;
  if(m<=240)return 7;
  if(m<=480)return 10;
  return 14;
}

function requiredMinutesPerDay(task,k=todayKey()){
  const d=deadlineDaysLeft(task,k);
  if(d===null)return 0;
  const rem=Math.max(0,Number(task.remainingMinutes??task.duration??0));
  if(d<=0)return rem;
  return rem/Math.max(1,d);
}

function isNeglectedTask(task,k=todayKey()){
  if(isCompleted(task))return false;
  const d=deadlineDaysLeft(task,k);
  if(d===null)return false;
  if(d<=0)return true;

  const rem=Math.max(0,Number(task.remainingMinutes??task.duration??0));
  if(rem<=0)return false;

  const pace=requiredMinutesPerDay(task,k);
  const inLeadWindow=d<=minimumLeadDays(rem);

  // Long-future/light tasks remain dormant. A task becomes neglected when
  // its required daily pace reaches 20 min/day, or its minimum lead window
  // has been reached without being placed today.
  const placedToday=isManualPlaced(task.id,k) || todaySchedule.some(e=>e.taskId===task.id);
  const progressedToday=hasProgressToday(task,k);
  return (pace>=DAILY_WORKLOAD_ALERT_MINUTES || inLeadWindow) && !placedToday && !progressedToday;
}

function neglectedReason(task,k=todayKey()){
  const d=deadlineDaysLeft(task,k);
  const pace=Math.ceil(requiredMinutesPerDay(task,k));
  if(d!==null && d<=0)return d===0?'今日が締切です':'締切を過ぎています';
  if(pace>=DAILY_WORKLOAD_ALERT_MINUTES)return '残り'+fmtMin(task.remainingMinutes??task.duration)+'・1日約'+pace+'分必要';
  return '着手推奨期間に入っています';
}

function urgency(task){
  const now=todayKey();
  const end=task.endDate || (task.deadline?task.deadline.slice(0,10):null);
  if(!end) return 15;
  const days=daysBetween(now,end);
  if(days<=0) return 100;
  if(days===1) return 80;
  if(days<=3) return 60;
  if(days<=7) return 40;
  return Math.max(10,30-days);
}
function targetForToday(task){
  const rem=Math.max(0,task.remainingMinutes??task.duration);
  if(task.mode==='fixed'||task.mode==='date') return rem;
  const days=availableDays(task);
  let base=Math.ceil(rem/days);
  if(days>1) base=Math.ceil(base*1.15/5)*5;
  return Math.min(rem,task.maxPerDay||120,Math.max(task.minChunk||state.settings.defaultMinChunk,base));
}
function priority(task){
  const rem=Math.max(1,task.remainingMinutes??task.duration);
  const days=availableDays(task);
  const pressure=Math.min(100,(rem/Math.max(1,days*60))*35);
  return urgency(task)+(task.importance||3)*12+pressure+(task.deferCount||0)*8+(task.mode==='range'?8:0);
}
function priorityClass(task){
  if(urgency(task)>=80 || targetForToday(task)>=Math.max(1,task.remainingMinutes||task.duration)) return 'must';
  if(priority(task)>=80) return 'recommended';
  return 'optional';
}
function labelPriority(task){
  const c=priorityClass(task); return c==='must'?'🔴 今日必須':c==='recommended'?'🟠 今日推奨':'🟡 余裕があれば';
}
function workWindow(date=new Date()){
  const weekend=[0,6].includes(date.getDay());
  return [timeToMinutes(weekend?state.settings.weekendStart:state.settings.weekdayStart),timeToMinutes(weekend?state.settings.weekendEnd:state.settings.weekdayEnd)];
}
function subtractSlot(slots,s,e){
  const out=[];
  for(const [a,b] of slots){
    if(e<=a||s>=b){out.push([a,b]);continue}
    if(s>a)out.push([a,s]); if(e<b)out.push([e,b]);
  }
  return out.filter(([a,b])=>b-a>=5);
}
function bestSlot(slots,len){
  let candidates=slots.map((s,i)=>({i,gap:s[1]-s[0],s})).filter(x=>x.gap>=len);
  candidates.sort((a,b)=>(a.gap-len)-(b.gap-len)||a.s[0]-b.s[0]);
  return candidates[0]||null;
}
function getManualPlacements(k=todayKey()){
  if(!state.manualPlacements)state.manualPlacements={};
  if(!state.manualPlacements[k])state.manualPlacements[k]={};
  return state.manualPlacements[k];
}
function isManualPlaced(taskId,k=todayKey()){
  return Number.isFinite(Number(getManualPlacements(k)[taskId]));
}
function clearManualPlacement(taskId,k=todayKey()){
  delete getManualPlacements(k)[taskId];
  save();
  buildTodayPlanner();
}
function overlaps(aStart,aEnd,bStart,bEnd){
  return aStart<bEnd&&aEnd>bStart;
}
function moveTaskTo(taskId,newStart){
  const t=taskById(taskId); if(!t)return;
  const [ws,we]=workWindow();
  const len=Math.max(5,t.remainingMinutes??t.duration);
  newStart=Math.round(Number(newStart)/30)*30;
  newStart=Math.max(ws,Math.min(we-len,newStart));

  const placements=getManualPlacements();
  placements[taskId]=newStart;
  save();
  buildTodayPlanner();
}

function shiftTask(taskId,delta){
  const e=todaySchedule.find(x=>x.taskId===taskId);
  if(e)moveTaskTo(taskId,e.start+delta);
}

function buildTodayPlanner(){
  const k=todayKey();
  const entries=[];
  const placements=getManualPlacements(k);
  const [ws,we]=workWindow();

  const fixed=validTasks().filter(t=>taskActiveOn(t,k)&&t.mode==='fixed');
  for(const t of fixed){
    const s=timeToMinutes(t.fixedStart||'09:00');
    const len=Math.max(5,t.remainingMinutes??t.duration);
    entries.push({taskId:t.id,start:s,end:s+len,minutes:len,fixed:true,manual:false,priority:'must'});
  }

  const manual=validTasks()
    .filter(t=>taskActiveOn(t,k)&&t.mode!=='fixed'&&isManualPlaced(t.id,k))
    .sort((a,b)=>Number(placements[a.id])-Number(placements[b.id]));

  for(const t of manual){
    const len=Math.max(5,t.remainingMinutes??t.duration);
    let s=Number(placements[t.id]);
    s=Math.max(ws,Math.min(we-len,s));
    placements[t.id]=s;
    entries.push({taskId:t.id,start:s,end:s+len,minutes:len,fixed:false,manual:true,priority:priorityClass(t)});
  }

  // Recover tasks completed before completedTimeline snapshots existed.
  state.completedTimeline=state.completedTimeline||{};
  state.completedTimeline[k]=state.completedTimeline[k]||{};
  const completedForDay=state.completedTimeline[k];

  for(const t of validTasks()){
    if(completedForDay[t.id])continue;

    const doneToday=(t.recurrence&&t.recurrence!=='none')
      ? isDoneToday(t,k)
      : (isCompleted(t) && (
          (t.mode==='date' || t.mode==='fixed') ? t.startDate===k :
          t.mode==='range' ? dateInRange(k,t.startDate,t.endDate) :
          true
        ));

    if(!doneToday)continue;

    let start=null;
    let fixed=t.mode==='fixed';
    let manual=false;

    if(fixed){
      start=timeToMinutes(t.fixedStart||'09:00');
    }else if(Object.prototype.hasOwnProperty.call(placements,t.id)){
      start=Number(placements[t.id]);
      manual=true;
    }

    if(!Number.isFinite(start))continue;

    const len=Math.max(5,Number(t.duration||30));
    completedForDay[t.id]={
      start,
      end:start+len,
      minutes:len,
      fixed,
      manual,
      priority:fixed?'must':'optional',
      beforeRemaining:len,
      beforeStatus:'open',
      legacyRecovered:true,
      completedAt:new Date().toISOString()
    };
  }

  for(const [taskId,snapshot] of Object.entries(completedForDay)){
    if(entries.some(e=>e.taskId===taskId))continue;
    const t=taskById(taskId); if(!t)continue;
    const start=Number(snapshot.start);
    const end=Number(snapshot.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
    entries.push({
      taskId,
      start,
      end,
      minutes:Number(snapshot.minutes)||Math.max(5,end-start),
      fixed:!!snapshot.fixed,
      manual:!!snapshot.manual,
      priority:snapshot.priority||'optional',
      completed:true
    });
  }

  entries.sort((a,b)=>a.start-b.start);
  todaySchedule=entries;
  render();
}

function scheduleToday(){
  buildTodayPlanner();
}
function plannedTaskMinutes(){return todaySchedule.reduce((s,x)=>s+x.minutes,0)}
function taskById(id){return validTasks().find(t=>t.id===id)}

function renderDataSafetyNotice(){
  const el=$('#dataSafetyBanner'); if(!el)return;
  if(!loadSafetyReason && !persistenceLocked){
    el.classList.add('hidden');
    return;
  }
  el.textContent=(persistenceLocked?'安全停止：':'データ保全：')+loadSafetyReason;
  el.classList.toggle('safety-stop',persistenceLocked);
  el.classList.remove('hidden');
}

function reportRenderError(step,err){
  console.error('Smart Schedule render error at '+step,err);
  const banner=$('#overloadBanner');
  if(banner){
    banner.textContent='表示エラー：'+step+' / '+(err?.message||String(err));
    banner.dataset.renderError='1';
    banner.classList.remove('hidden');
  }
}

function safeRenderStep(step,fn){
  try{fn();return true}
  catch(err){reportRenderError(step,err);return false}
}

function render(){
  safeRenderStep('基本情報',()=>{
    $('#todayLabel').textContent=new Date().toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
    const active=validTasks().filter(t=>taskActiveOn(t));
    const done=validTasks().filter(t=>isDoneToday(t)||isCompleted(t));
    $('#plannedMinutes').textContent=fmtMin(plannedTaskMinutes());
    $('#doneCount').textContent=done.length+' / '+(active.length+done.length);
    $('#mustCount').textContent=active.filter(t=>priorityClass(t)==='must').length+'件';
    const [ws,we]=workWindow();
    $('#freeMinutes').textContent=fmtMin(Math.max(0,we-ws-plannedTaskMinutes()));
  });

  safeRenderStep('時間割',renderTimeline);
  safeRenderStep('付箋',renderMemoBoard);
  safeRenderStep('今日のTODO',renderTodayTasks);
  safeRenderStep('タスク一覧',renderAllTasks);
  safeRenderStep('次にやること',renderNext);
  safeRenderStep('放置中タスク',renderNeglectedTasks);
  safeRenderStep('警告表示',renderOverload);
  safeRenderStep('設定',loadSettings);
  renderDataSafetyNotice();
  requestAnimationFrame(applyViewportScale);
}
function renderNeglectedTasks(){
  const section=$('#neglectedSection');
  const box=$('#neglectedTasks');
  const count=$('#neglectedCount');
  if(!section||!box||!count)return;

  const items=validTasks()
    .filter(t=>isNeglectedTask(t))
    .sort((a,b)=>{
      const ad=deadlineDaysLeft(a), bd=deadlineDaysLeft(b);
      if(ad!==bd)return (ad??9999)-(bd??9999);
      return requiredMinutesPerDay(b)-requiredMinutesPerDay(a);
    });

  count.textContent=items.length+'件';
  section.classList.toggle('hidden',items.length===0);

  box.innerHTML=items.map(t=>{
    const dl=deadlineLabel(t);
    return '<button type="button" class="neglected-task-item" data-edit="'+t.id+'">'+
      '<span class="neglected-task-main"><strong>'+esc(t.title)+'</strong><small>'+esc(neglectedReason(t))+'</small></span>'+
      '<span class="neglected-task-deadline '+deadlineClass(t)+'">'+esc(dl)+'</span>'+
    '</button>';
  }).join('');
}

function renderOverload(){
  const el=$('#overloadBanner');
  if(el && !el.dataset.renderError)el.classList.add('hidden');
}
function computeTimelineLanes(entries){
  const sorted=entries
    .filter(e=>Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.end>e.start)
    .map((e,i)=>({e,i}))
    .sort((a,b)=>a.e.start-b.e.start||a.e.end-b.e.end);

  const result=new Map();
  let component=[];
  let componentEnd=-Infinity;

  const flush=()=>{
    if(!component.length)return;
    const active=[];
    let maxCols=1;

    for(const item of component){
      for(let i=active.length-1;i>=0;i--){
        if(active[i].end<=item.e.start)active.splice(i,1);
      }
      const used=new Set(active.map(x=>x.col));
      let col=0;
      while(used.has(col))col++;
      active.push({end:item.e.end,col});
      item.col=col;
      maxCols=Math.max(maxCols,col+1);
    }

    for(const item of component){
      result.set(item.e.taskId,{col:item.col||0,total:maxCols,overlap:maxCols>1});
    }
    component=[];
    componentEnd=-Infinity;
  };

  for(const item of sorted){
    if(component.length && item.e.start>=componentEnd)flush();
    component.push(item);
    componentEnd=Math.max(componentEnd,item.e.end);
  }
  flush();
  return result;
}

function renderTimeline(){
  const box=$('#timeline');
  const [ws,we]=workWindow();
  const pxPer30=48;
  const totalHeight=Math.max(96,((we-ws)/30)*pxPer30);

  const trayTasks=validTasks()
    .filter(t=>taskActiveOn(t)&&t.mode!=='fixed'&&!isManualPlaced(t.id))
    .sort((a,b)=>{
      const ao=taskIsOverdue(a), bo=taskIsOverdue(b);
      if(ao!==bo)return ao?-1:1;
      return priority(b)-priority(a);
    });

  const tray=trayTasks.length
    ? trayTasks.map(t=>{
        const overdue=taskIsOverdue(t);
        return '<div class="task-sticky'+(overdue?' overdue':'')+'" data-tray-task="'+t.id+'" tabindex="0">'+
          '<span class="sticky-title">'+esc(t.title)+'</span>'+
          '<span class="sticky-meta">'+fmtMin(t.remainingMinutes??t.duration)+' ・ '+'★'.repeat(t.importance||3)+(overdue?' ・ <b class="tray-overdue-badge">期限切れ</b>':(deadlineLabel(t)?' ・ '+deadlineLabel(t):''))+'</span>'+
          '<button type="button" data-place="'+t.id+'" title="時刻を入力して配置">配置</button>'+
        '</div>';
      }).join('')
    : '<div class="tray-empty">今日の未配置タスクはありません。</div>';

  let labels='';
  for(let m=ws;m<=we;m+=30){
    const major=m%60===0;
    labels+='<div class="planner-time '+(major?'major':'')+'" style="top:'+(((m-ws)/30)*pxPer30)+'px">'+(major?minutesToTime(m):'')+'</div>';
  }

  let cards='';
  const laneMap=computeTimelineLanes(todaySchedule);
  for(const e of todaySchedule){
    if(e.start<ws||e.start>=we)continue;
    const top=((e.start-ws)/30)*pxPer30;
    const height=Math.max(18,((e.end-e.start)/30)*pxPer30);
    const t=taskById(e.taskId); if(!t)continue;
    const cls=e.fixed?'fixed':'manual';
    const compact=e.minutes<=30?' compact':'';
    const completed=e.completed?' completed':'';
    const progressed=!e.completed&&hasProgressToday(t)?' progressed':'';
    const lane=laneMap.get(e.taskId)||{col:0,total:1,overlap:false};
    const laneStyle='left:calc(8px + (100% - 16px) * '+lane.col+'/'+lane.total+');right:calc(8px + (100% - 16px) * '+(lane.total-lane.col-1)+'/'+lane.total+');';
    cards+='<article class="planner-task '+cls+compact+completed+progressed+(lane.overlap?' planner-overlap':'')+'" data-planner-task="'+t.id+'" style="top:'+top+'px;height:'+height+'px;'+laneStyle+'">'+
      '<button type="button" class="drag-handle" data-drag="'+t.id+'" aria-label="'+esc(t.title)+'を時間移動">⋮⋮</button>'+
      '<div class="planner-task-time">'+minutesToTime(e.start)+'〜'+minutesToTime(e.end)+'</div>'+
      '<div class="planner-task-body"><b>'+esc(t.title)+'</b><div class="meta">'+fmtMin(e.minutes)+(deadlineLabel(t)?' ・ '+deadlineLabel(t):'')+'</div></div>'+
      '<div class="planner-task-actions">'+
        (e.completed
          ? ''
          : ((!e.fixed?'<button type="button" data-shift="'+t.id+'" data-delta="-30">−30</button><button type="button" data-shift="'+t.id+'" data-delta="30">+30</button><button type="button" data-auto="'+t.id+'">戻す</button>':'')+
            (hasProgressToday(t)
              ? '<span class="planner-progress-label">今日はOK ✓</span>'
              : '<button type="button" class="planner-progress-btn" data-progress="'+t.id+'">今日はOK</button>')+
            '<button type="button" data-done="'+t.id+'" data-min="'+e.minutes+'">完了</button>'))+
      '</div>'+
      (e.completed?'<button type="button" class="planner-undo-done planner-undo-outside" data-undo-done="'+t.id+'">完了を取り消す</button>':'')+
      '</article>';
  }

  box.innerHTML=
    '<div class="task-tray-section">'+
      '<div class="tray-head"><b>今日のタスク置き場</b><span>付箋を下の時間割へドラッグしてください</span></div>'+
      '<div class="task-tray">'+tray+'</div>'+
    '</div>'+
    '<div class="planner-wrap"><div class="planner-labels" style="height:'+totalHeight+'px">'+labels+'</div>'+
    '<div class="planner-canvas" style="height:'+totalHeight+'px" data-ws="'+ws+'" data-px="'+pxPer30+'">'+cards+'</div></div>';

  setupPlannerDragging();
  setupTrayDragging();
}

function setupPlannerDragging(){
  const canvas=$('.planner-canvas'); if(!canvas)return;
  $$('.drag-handle').forEach(handle=>{
    handle.addEventListener('pointerdown',e=>{
      if(e.button!==undefined&&e.button!==0)return;
      const id=handle.dataset.drag;
      const card=handle.closest('.planner-task');
      const entry=todaySchedule.find(x=>x.taskId===id);
      if(!card||!entry||entry.fixed)return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      const startY=e.clientY;
      const original=entry.start;
      card.classList.add('dragging');

      const move=ev=>{
        const dy=ev.clientY-startY;
        const delta=Math.round(dy/48)*30;
        card.style.transform='translateY('+(delta/30*48)+'px)';
      };
      const up=ev=>{
        handle.releasePointerCapture?.(e.pointerId);
        handle.removeEventListener('pointermove',move);
        handle.removeEventListener('pointerup',up);
        handle.removeEventListener('pointercancel',up);
        card.classList.remove('dragging');
        const dy=ev.clientY-startY;
        const delta=Math.round(dy/48)*30;
        moveTaskTo(id,original+delta);
      };
      handle.addEventListener('pointermove',move);
      handle.addEventListener('pointerup',up);
      handle.addEventListener('pointercancel',up);
    });
  });
}

function setupTrayDragging(){
  const canvas=$('.planner-canvas'); if(!canvas)return;

  $$('[data-tray-task]').forEach(sticky=>{
    sticky.addEventListener('click',e=>{
      if(e.target.closest('button'))return;
      if(sticky.dataset.wasDragged==='1'){
        sticky.dataset.wasDragged='0';
        return;
      }
      const t=taskById(sticky.dataset.trayTask);
      if(t)openTask(t);
    });

    sticky.addEventListener('pointerdown',e=>{
      if(e.target.closest('button'))return;
      if(e.button!==undefined&&e.button!==0)return;
      const id=sticky.dataset.trayTask;
      const t=taskById(id); if(!t)return;
      e.preventDefault();
      sticky.dataset.wasDragged='0';
      const dragStartX=e.clientX;
      const dragStartY=e.clientY;

      const ghost=document.createElement('div');
      ghost.className='sticky-ghost';
      ghost.textContent=t.title+' ・ '+fmtMin(t.remainingMinutes??t.duration);
      document.body.appendChild(ghost);

      const move=ev=>{
        if(Math.hypot(ev.clientX-dragStartX,ev.clientY-dragStartY)>5)sticky.dataset.wasDragged='1';
        ghost.style.left=(ev.clientX+12)+'px';
        ghost.style.top=(ev.clientY+12)+'px';
      };
      move(e);

      const up=ev=>{
        document.removeEventListener('pointermove',move);
        document.removeEventListener('pointerup',up);
        document.removeEventListener('pointercancel',up);
        ghost.remove();

        const rect=canvas.getBoundingClientRect();
        if(ev.clientX<rect.left||ev.clientX>rect.right||ev.clientY<rect.top||ev.clientY>rect.bottom)return;
        const ws=Number(canvas.dataset.ws);
        const px=Number(canvas.dataset.px);
        const offset=Math.max(0,ev.clientY-rect.top);
        const start=ws+Math.round(offset/px)*30;
        moveTaskTo(id,start);
      };

      document.addEventListener('pointermove',move);
      document.addEventListener('pointerup',up);
      document.addEventListener('pointercancel',up);
    });
  });
}

function promptPlaceTask(id){
  const t=taskById(id); if(!t)return;
  const [ws]=workWindow();
  const v=prompt('開始時刻を入力してください（例 18:30）',minutesToTime(ws));
  if(!v)return;
  if(!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)){
    alert('時刻は 18:30 のように入力してください。');
    return;
  }
  moveTaskTo(id,timeToMinutes(v));
}
let selectedMemoIds=new Set();

function applyMemoSelectionClasses(){
  $('.memo-note').forEach(el=>{
    el.classList.toggle('selected',selectedMemoIds.has(el.dataset.memoId));
  });
}

function setSingleMemoSelection(id){
  selectedMemoIds=new Set(id?[id]:[]);
  applyMemoSelectionClasses();
}

function toggleMemoSelection(id){
  if(selectedMemoIds.has(id))selectedMemoIds.delete(id);
  else selectedMemoIds.add(id);
  applyMemoSelectionClasses();
}

function startInlineMemoEdit(note,el){
  if(!note||!el)return;
  const textEl=el.querySelector('.memo-note-text');
  if(!textEl||textEl.isContentEditable)return;

  const original=note.text||'';
  textEl.contentEditable='true';
  textEl.classList.add('editing');
  textEl.textContent=original;
  textEl.focus();

  const range=document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let finished=false;
  const finish=(saveChanges=true)=>{
    if(finished)return;
    finished=true;
    textEl.removeEventListener('blur',onBlur);
    textEl.removeEventListener('keydown',onKey);
    textEl.contentEditable='false';
    textEl.classList.remove('editing');

    if(saveChanges){
      const value=textEl.innerText.replace(/\r/g,'').trim();
      note.text=value;
      if(!save()){
        note.text=original;
      }
    }
    renderMemoBoard();
  };
  const onBlur=()=>finish(true);
  const onKey=e=>{
    if(e.key==='Escape'){
      e.preventDefault();
      note.text=original;
      finish(false);
    }else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){
      e.preventDefault();
      finish(true);
    }
  };

  textEl.addEventListener('blur',onBlur);
  textEl.addEventListener('keydown',onKey);
}

function memoColorClass(color){
  return ['red','yellow','green','blue'].includes(color)?color:'green';
}

function bringMemoToFront(note,el){
  if(!note||!el)return;
  const maxZ=Math.max(0,...(state.memoNotes||[]).map(n=>Number(n.z)||0));
  note.z=maxZ+1;
  el.style.zIndex=String(note.z);
  save();
}

function renderMemoBoard(){
  const board=$('#memoBoard'); if(!board)return;
  board.innerHTML='';
  const notes=validMemos();
  const maxW=Math.max(260,board.clientWidth||360);

  for(const note of notes){
    const el=document.createElement('article');
    el.className='memo-note memo-'+memoColorClass(note.color)+(note.important?' important':'');
    el.dataset.memoId=note.id;

    const w=Math.max(180,Math.min(Number(note.w)||260,maxW-12));
    const h=Math.max(88,Number(note.h)||115);
    const x=Math.max(0,Math.min(Number(note.x)||10,Math.max(0,maxW-w-6)));
    const y=Math.max(0,Number(note.y)||10);

    note.w=w;note.h=h;note.x=x;note.y=y;
    if(!Number.isFinite(Number(note.z)))note.z=notes.indexOf(note)+1;
    el.style.left=x+'px';
    el.style.top=y+'px';
    el.style.width=w+'px';
    el.style.height=h+'px';
    el.style.zIndex=String(note.z);

    el.addEventListener('pointerdown',e=>{
      if(e.target.closest('.memo-note-text')?.isContentEditable)return;
      bringMemoToFront(note,el);
    });

    el.addEventListener('click',e=>{
      if(e.target.closest('button')||e.target.closest('.memo-resize-handle'))return;
      if(e.shiftKey)toggleMemoSelection(note.id);
      else if(!selectedMemoIds.has(note.id))setSingleMemoSelection(note.id);
    });

    el.addEventListener('dblclick',e=>{
      const textEl=e.target.closest('.memo-note-text');
      if(!textEl)return;
      e.preventDefault();
      e.stopPropagation();
      setSingleMemoSelection(note.id);
      startInlineMemoEdit(note,el);
    });

    el.innerHTML=
      '<div class="memo-note-bar" data-memo-drag="'+note.id+'">'+
        '<span class="memo-grip">⋮⋮</span>'+
        '<span class="memo-note-label">付箋</span>'+
        '<div class="memo-note-actions">'+
          '<button type="button" class="memo-important-toggle'+(note.important?' active':'')+'" data-toggle-important="'+note.id+'" aria-label="重要を切り替え">!</button>'+
          '<button type="button" class="memo-mini-btn" data-edit-memo="'+note.id+'">編集</button>'+
          '<button type="button" class="memo-delete-x" data-delete-memo="'+note.id+'" aria-label="付箋を削除">×</button>'+
        '</div>'+
      '</div>'+
      '<div class="memo-note-text">'+esc(note.text||'').replace(/\n/g,'<br>')+'</div>'+
      '<span class="memo-resize-handle resize-n" data-resize="n"></span>'+
      '<span class="memo-resize-handle resize-e" data-resize="e"></span>'+
      '<span class="memo-resize-handle resize-s" data-resize="s"></span>'+
      '<span class="memo-resize-handle resize-w" data-resize="w"></span>'+
      '<span class="memo-resize-handle resize-ne" data-resize="ne"></span>'+
      '<span class="memo-resize-handle resize-se" data-resize="se"></span>'+
      '<span class="memo-resize-handle resize-sw" data-resize="sw"></span>'+
      '<span class="memo-resize-handle resize-nw" data-resize="nw"></span>';

    board.appendChild(el);
  }
  applyMemoSelectionClasses();
  setupMemoDragging();
  setupMemoResizing();
}

function openMemo(note=null){
  $('#memoForm').reset();
  $('#memoId').value=note?.id||'';
  $('#memoDialogTitle').textContent=note?'付箋を編集':'付箋を作成';
  $('#memoText').value=note?.text||'';
  const color=note?.color||'green';
  const radio=document.querySelector('input[name="memoColor"][value="'+color+'"]');
  if(radio)radio.checked=true;
  const important=$('#memoImportant'); if(important)important.checked=!!note?.important;
  $('#deleteMemoBtn').classList.toggle('hidden',!note);
  $('#memoDialog').showModal();
  setTimeout(()=>$('#memoText')?.focus(),0);
}

function saveMemo(){
  const id=$('#memoId').value;
  const textValue=$('#memoText').value.trim();
  if(!textValue)return;
  const color=document.querySelector('input[name="memoColor"]:checked')?.value||'green';
  const important=!!$('#memoImportant')?.checked;
  const old=id?state.memoNotes.find(n=>n.id===id):null;

  if(old){
    old.text=textValue;
    old.color=color;
    old.important=important;
  }else{
    const count=state.memoNotes.length;
    state.memoNotes.push({
      id:uuid(),
      text:textValue,
      color,
      important,
      x:12+(count%3)*28,
      y:12+(count%5)*26,
      w:260,
      h:115,
      z:Math.max(0,...state.memoNotes.map(n=>Number(n.z)||0))+1,
      createdAt:new Date().toISOString()
    });
  }
  save();
  $('#memoDialog').close();
  renderMemoBoard();
}

function toggleMemoImportant(id){
  const note=state.memoNotes.find(n=>n.id===id); if(!note)return;
  note.important=!note.important;
  save();
  renderMemoBoard();
}

function deleteMemo(){
  const id=$('#memoId').value;
  if(!id)return;
  if(!confirm('この付箋を削除しますか？'))return;
  state.memoNotes=state.memoNotes.filter(n=>n.id!==id);
  save();
  $('#memoDialog').close();
  renderMemoBoard();
}

function setupMemoDragging(){
  const board=$('#memoBoard'); if(!board)return;
  $$('[data-memo-drag]').forEach(bar=>{
    bar.addEventListener('pointerdown',e=>{
      if(e.target.closest('button'))return;
      if(e.button!==undefined&&e.button!==0)return;

      const id=bar.dataset.memoDrag;
      const note=state.memoNotes.find(n=>n.id===id);
      const el=bar.closest('.memo-note');
      if(!note||!el)return;

      if(e.shiftKey){
        e.preventDefault();
        toggleMemoSelection(id);
        return;
      }

      if(!selectedMemoIds.has(id))setSingleMemoSelection(id);
      bringMemoToFront(note,el);

      const movingIds=[...selectedMemoIds].filter(x=>state.memoNotes.some(n=>n.id===x));
      if(!movingIds.includes(id))movingIds.push(id);

      const items=movingIds.map(mid=>{
        const n=state.memoNotes.find(x=>x.id===mid);
        const node=board.querySelector('.memo-note[data-memo-id="'+CSS.escape(mid)+'"]');
        return n&&node?{
          note:n,
          el:node,
          x:Number(n.x)||0,
          y:Number(n.y)||0,
          w:node.offsetWidth,
          h:node.offsetHeight
        }:null;
      }).filter(Boolean);
      if(!items.length)return;

      e.preventDefault();
      bar.setPointerCapture?.(e.pointerId);

      const rect=board.getBoundingClientRect();
      const scaleX=rect.width/Math.max(1,board.offsetWidth);
      const scaleY=rect.height/Math.max(1,board.offsetHeight);
      const startX=e.clientX;
      const startY=e.clientY;

      let minDx=-Infinity,maxDx=Infinity,minDy=-Infinity,maxDy=Infinity;
      for(const item of items){
        minDx=Math.max(minDx,-item.x);
        maxDx=Math.min(maxDx,board.offsetWidth-item.w-item.x);
        minDy=Math.max(minDy,-item.y);
        maxDy=Math.min(maxDy,board.offsetHeight-item.h-item.y);
        item.el.classList.add('moving');
      }

      const delta=ev=>{
        let dx=(ev.clientX-startX)/Math.max(.01,scaleX);
        let dy=(ev.clientY-startY)/Math.max(.01,scaleY);
        dx=Math.max(minDx,Math.min(maxDx,dx));
        dy=Math.max(minDy,Math.min(maxDy,dy));
        return {dx,dy};
      };

      const move=ev=>{
        const {dx,dy}=delta(ev);
        for(const item of items){
          item.el.style.left=(item.x+dx)+'px';
          item.el.style.top=(item.y+dy)+'px';
        }
      };

      const up=ev=>{
        bar.releasePointerCapture?.(e.pointerId);
        bar.removeEventListener('pointermove',move);
        bar.removeEventListener('pointerup',up);
        bar.removeEventListener('pointercancel',up);
        const {dx,dy}=delta(ev);
        for(const item of items){
          item.el.classList.remove('moving');
          item.note.x=Math.round(item.x+dx);
          item.note.y=Math.round(item.y+dy);
        }
        save();
        renderMemoBoard();
      };

      bar.addEventListener('pointermove',move);
      bar.addEventListener('pointerup',up);
      bar.addEventListener('pointercancel',up);
    });
  });
}

function setupMemoResizing(){
  const board=$('#memoBoard'); if(!board)return;
  $$('.memo-resize-handle').forEach(handle=>{
    handle.addEventListener('pointerdown',e=>{
      if(e.button!==undefined&&e.button!==0)return;
      const el=handle.closest('.memo-note');
      const id=el?.dataset.memoId;
      const note=state.memoNotes.find(n=>n.id===id);
      if(!el||!note)return;

      bringMemoToFront(note,el);
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture?.(e.pointerId);

      const dir=handle.dataset.resize||'se';
      const boardRect=board.getBoundingClientRect();
      const scaleX=boardRect.width/Math.max(1,board.offsetWidth);
      const scaleY=boardRect.height/Math.max(1,board.offsetHeight);

      const startX=e.clientX;
      const startY=e.clientY;
      const startW=el.offsetWidth;
      const startH=el.offsetHeight;
      const startLeft=Number(note.x)||0;
      const startTop=Number(note.y)||0;
      const minW=180;
      const minH=88;
      el.classList.add('resizing');

      const calc=ev=>{
        const dx=(ev.clientX-startX)/Math.max(.01,scaleX);
        const dy=(ev.clientY-startY)/Math.max(.01,scaleY);

        let left=startLeft;
        let top=startTop;
        let width=startW;
        let height=startH;

        if(dir.includes('e')){
          width=Math.max(minW,startW+dx);
        }
        if(dir.includes('s')){
          height=Math.max(minH,startH+dy);
        }
        if(dir.includes('w')){
          const proposed=Math.max(minW,startW-dx);
          left=startLeft+(startW-proposed);
          width=proposed;
          if(left<0){
            width+=left;
            left=0;
          }
        }
        if(dir.includes('n')){
          const proposed=Math.max(minH,startH-dy);
          top=startTop+(startH-proposed);
          height=proposed;
          if(top<0){
            height+=top;
            top=0;
          }
        }

        width=Math.min(width,board.offsetWidth-left);
        height=Math.min(height,board.offsetHeight-top);

        return {
          left:Math.max(0,left),
          top:Math.max(0,top),
          width:Math.max(minW,width),
          height:Math.max(minH,height)
        };
      };

      const move=ev=>{
        const v=calc(ev);
        el.style.left=v.left+'px';
        el.style.top=v.top+'px';
        el.style.width=v.width+'px';
        el.style.height=v.height+'px';
      };

      const up=ev=>{
        handle.releasePointerCapture?.(e.pointerId);
        handle.removeEventListener('pointermove',move);
        handle.removeEventListener('pointerup',up);
        handle.removeEventListener('pointercancel',up);
        el.classList.remove('resizing');

        const v=calc(ev);
        note.x=Math.round(v.left);
        note.y=Math.round(v.top);
        note.w=Math.round(v.width);
        note.h=Math.round(v.height);
        save();
      };

      handle.addEventListener('pointermove',move);
      handle.addEventListener('pointerup',up);
      handle.addEventListener('pointercancel',up);
    });
  });
}

function renderNext(){
  const now=new Date();const m=now.getHours()*60+now.getMinutes();
  const pending=todaySchedule.filter(e=>!e.completed && !isDoneToday(taskById(e.taskId)) && !hasProgressToday(taskById(e.taskId)) && !isCompleted(taskById(e.taskId)));
  const e=pending.find(x=>x.end>=m)||pending[0];
  const box=$('#nextTask');
  if(!e){box.innerHTML='<div class="empty">次の予定はありません。</div>';return}
  const t=taskById(e.taskId);
  if(!t){box.innerHTML='<div class="empty">次の予定はありません。</div>';return}
  box.innerHTML='<div class="next-box"><div><strong>'+esc(t.title)+'</strong><div class="meta">'+minutesToTime(e.start)+'〜'+minutesToTime(e.end)+' ・ '+labelPriority(t)+'</div></div><button class="primary" data-done="'+t.id+'" data-min="'+e.minutes+'">完了</button></div>';
}
function todayTaskTone(t){
  if(!t)return 'normal';
  const days=deadlineDaysLeft(t);
  if(taskIsOverdue(t) || (days!=null && days<=2))return 'attention';
  if(t.recurrence&&t.recurrence!=='none')return 'recurring';
  return 'normal';
}

function taskCard(t,today=false){
  const rem=Math.max(0,t.remainingMinutes??t.duration);
  const deadline=t.endDate|| (t.deadline?t.deadline.slice(0,10):'');
  const dLabel=deadlineLabel(t);
  const dClass=deadlineClass(t);
  const neglected=isNeglectedTask(t);
  const todayTone=today?todayTaskTone(t):'';
  return '<article class="task-card '+(isCompleted(t)?'done':'')+(neglected?' neglected':'')+(today?' today-task today-'+todayTone:'')+'"><div><h3>'+esc(t.title)+'</h3><div class="task-tags"><span class="tag '+(priorityClass(t)==='must'?'red':priorityClass(t)==='recommended'?'orange':'blue')+'">'+labelPriority(t)+'</span><span class="tag">'+'★'.repeat(t.importance||3)+'</span><span class="tag">残り '+fmtMin(rem)+'</span>'+(dLabel?'<span class="tag deadline-tag '+dClass+'">'+esc(dLabel)+'</span>':'')+(neglected?'<span class="tag neglected-tag">放置中</span>':'')+(t.recurrence&&t.recurrence!=='none'?'<span class="tag recurring-tag">定期</span>':'')+(t.deferCount?'<span class="tag">延期 '+t.deferCount+'回</span>':'')+'</div></div><div class="card-actions">'+(!isCompleted(t)?'<button data-done="'+t.id+'" data-min="'+Math.min(rem,targetForToday(t))+'">完了</button><button data-defer="'+t.id+'">延期</button>':'')+'<button data-edit="'+t.id+'">編集</button></div></article>';
}
function renderTodayTasks(){
  const a=validTasks().filter(t=>taskActiveOn(t)).sort((x,y)=>priority(y)-priority(x));
  $('#todayTasks').innerHTML=a.length?a.map(t=>taskCard(t,true)).join(''):'<div class="empty">今日のタスクはありません。</div>';
}
let currentTaskFilter='normal';

function renderAllTasks(){
  const f=currentTaskFilter||'normal';
  let a=[...validTasks()];

  if(f==='normal'){
    a=a.filter(t=>!isCompleted(t) && (!t.recurrence || t.recurrence==='none'));
  }else if(f==='recurring'){
    a=a.filter(t=>t.recurrence && t.recurrence!=='none');
  }else if(f==='done'){
    a=a.filter(t=>isCompleted(t));
  }

  a.sort((x,y)=>priority(y)-priority(x));
  $('#allTasks').innerHTML=a.length?a.map(t=>taskCard(t)).join(''):'<div class="empty">該当するタスクはありません。</div>';
}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

function markProgressToday(id){
  const t=taskById(id); if(!t||isCompleted(t))return;
  const k=todayKey();
  t.progressDates=[...(t.progressDates||[]).filter(x=>x!==k),k];
  t.lastProgressAt=new Date().toISOString();
  save();
  buildTodayPlanner();
}

function completeTask(id,minutes){
  const t=taskById(id);if(!t)return;
  const k=todayKey();
  const scheduled=todaySchedule.find(e=>e.taskId===id);

  if(scheduled){
    state.completedTimeline=state.completedTimeline||{};
    state.completedTimeline[k]=state.completedTimeline[k]||{};
    state.completedTimeline[k][id]={
      start:scheduled.start,
      end:scheduled.end,
      minutes:scheduled.minutes,
      fixed:!!scheduled.fixed,
      manual:!!scheduled.manual,
      priority:scheduled.priority||'optional',
      beforeRemaining:Number(t.remainingMinutes??t.duration),
      beforeStatus:t.status||'open',
      completedAt:new Date().toISOString()
    };
  }

  if(t.recurrence&&t.recurrence!=='none'){
    t.completionDates=[...(t.completionDates||[]).filter(x=>x!==k),k];
  }else{
    t.remainingMinutes=Math.max(0,(t.remainingMinutes??t.duration)-Number(minutes||t.duration));
    if(t.remainingMinutes<=0)t.status='done';
  }
  state.completionLog[k]=(state.completionLog[k]||0)+Number(minutes||0);
  save();buildTodayPlanner();
}

function undoCompleteTask(id){
  const t=taskById(id); if(!t)return;
  const k=todayKey();
  const snapshot=state.completedTimeline?.[k]?.[id];
  if(!snapshot)return;

  if(t.recurrence&&t.recurrence!=='none'){
    t.completionDates=(t.completionDates||[]).filter(x=>x!==k);
  }else{
    t.remainingMinutes=Number(snapshot.beforeRemaining ?? snapshot.minutes ?? t.duration);
    t.status=snapshot.beforeStatus||'open';
    if(t.remainingMinutes>0 && t.status==='done')t.status='open';
  }

  if(state.completionLog?.[k]!=null){
    state.completionLog[k]=Math.max(0,Number(state.completionLog[k])-Number(snapshot.minutes||0));
  }

  delete state.completedTimeline[k][id];
  if(Object.keys(state.completedTimeline[k]).length===0)delete state.completedTimeline[k];

  save();
  buildTodayPlanner();
}
function deferTask(id){
  const t=taskById(id);if(!t)return;t.deferCount=(t.deferCount||0)+1;
  if(t.mode==='date'){
    const d=new Date((t.startDate||todayKey())+'T12:00:00');d.setDate(d.getDate()+1);t.startDate=toDateKey(d);
  }
  save();buildTodayPlanner();
}
function dayDone(){
  for(const e of todaySchedule){
    const t=taskById(e.taskId);if(t&&!isCompleted(t)){t.deferCount=(t.deferCount||0)+1}
  }
  save();buildTodayPlanner();alert('未完了タスクを明日以降の再配置対象にしました。');
}

function openTask(t=null){
  $('#taskForm').reset();$('#taskId').value=t?.id||'';$('#dialogTitle').textContent=t?'タスク編集':'タスク追加';
  $('#deleteTaskBtn').classList.toggle('hidden',!t);
  $('#title').value=t?.title||'';$('#notes').value=t?.notes||'';$('#category').value=t?.category||'';
  $('#importance').value=t?.importance||3;$('#duration').value=t?.duration||30;$('#intensity').value=t?.intensity||'normal';
  $('#scheduleMode').value=t?.mode||'date';$('#deadline').value=t?.deadline||'';
  $('#recurrence').value=t?.recurrence||'none';
  const overdueInfo=$('#taskOverdueInfo');
  if(overdueInfo){
    const detail=t?taskOverdueDetail(t):'';
    overdueInfo.textContent=detail;
    overdueInfo.classList.toggle('hidden',!detail);
  }
  const spl=$('#splittable'); if(spl)spl.checked=t?.splittable??false;
  const min=$('#minChunk'); if(min)min.value=t?.minChunk||state.settings.defaultMinChunk;
  const max=$('#maxPerDay'); if(max)max.value=t?.maxPerDay||120;
  const lock=$('#locked'); if(lock)lock.checked=t?.locked||false;
  renderModeFields(t);renderWeekdays(t?.weekdays||[],t?.fixedStart||'18:00');
  $('#taskDialog').showModal();
}
function renderModeFields(t={}){
  t=t||{};
  const recurrence=$('#recurrence')?.value||t.recurrence||'none';
  const weekly=recurrence==='weekly';
  if(weekly && $('#scheduleMode'))$('#scheduleMode').value='fixed';

  const mode=$('#scheduleMode').value;const box=$('#modeFields');
  const recurring=recurrence!=='none';

  if(mode==='fixed'){
    const dateLabel=recurring?'繰り返し開始日':'日付';
    if(weekly){
      box.innerHTML='<label>'+dateLabel+'<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label>';
    }else{
      box.innerHTML='<div class="form-grid"><label>'+dateLabel+'<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>開始時刻<input id="fixedStart" type="time" value="'+(t.fixedStart||'18:00')+'"></label></div>';
    }
  }
  else if(mode==='date')box.innerHTML='<label>'+(recurring?'繰り返し開始日':'実施日')+'<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label>';
  else if(mode==='range')box.innerHTML='<div class="form-grid"><label>開始日<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>終了日<input id="endDate" type="date" value="'+(t.endDate||todayKey())+'"></label></div>';
  else box.innerHTML='<label>開始可能日（任意）<input id="startDate" type="date" value="'+(t.startDate||'')+'"></label>';
}
function renderWeekdays(selected=[],fixedStart='18:00'){
  const box=$('#weekdayPicker');const show=$('#recurrence').value==='weekly';box.classList.toggle('hidden',!show);
  if(!show){box.innerHTML='';return}
  box.innerHTML=
    '<div class="weekly-recurrence-settings">'+
      '<div class="weekday-help">実行する曜日を選択</div>'+
      '<div class="weekday-options">'+WEEKDAYS.map((d,i)=>'<label><input type="checkbox" value="'+i+'" '+(selected.includes(i)?'checked':'')+'> '+d+'</label>').join('')+'</div>'+
      '<label class="weekly-time-field">開始時刻<input id="fixedStart" type="time" value="'+(fixedStart||'18:00')+'"></label>'+
    '</div>';
}
function saveTask(){
  const id=$('#taskId').value;const old=id?taskById(id):null;
  const duration=Number($('#duration').value||30);
  if($('#recurrence').value==='weekly' && $('#weekdayPicker input:checked').length===0){
    alert('毎週のタスクは、実行する曜日を1つ以上選んでください。');
    return;
  }
  const t={
    id:id||uuid(),title:$('#title').value.trim(),notes:$('#notes').value.trim(),category:$('#category').value.trim(),
    importance:Number($('#importance').value),duration,intensity:$('#intensity').value,mode:$('#scheduleMode').value,
    startDate:$('#startDate')?.value||'',endDate:$('#endDate')?.value||'',fixedStart:$('#fixedStart')?.value||'',
    deadline:$('#deadline').value,recurrence:$('#recurrence').value,
    weekdays:$$('#weekdayPicker input:checked').map(x=>Number(x.value)),
    splittable:$('#splittable')?.checked??false,minChunk:Number($('#minChunk')?.value||30),maxPerDay:Number($('#maxPerDay')?.value||120),
    locked:$('#locked')?.checked??false,deferCount:old?.deferCount||0,completionDates:old?.completionDates||[],progressDates:old?.progressDates||[],
    remainingMinutes:(()=>{
      if(!old)return duration;
      if(old.status==='done')return 0;
      const oldDuration=Number(old.duration||duration);
      const oldRemaining=Number(old.remainingMinutes??oldDuration);
      if(duration!==oldDuration)return duration;
      return oldRemaining;
    })(),
    status:old?.status||'open',createdAt:old?.createdAt||new Date().toISOString()
  };
  if(old)Object.assign(old,t);else state.tasks.push(t);
  save();$('#taskDialog').close();scheduleToday();
}
function deleteTask(){
  const id=$('#taskId').value;if(!id)return;if(!confirm('このタスクを削除しますか？'))return;
  state.tasks=state.tasks.filter(t=>t.id!==id);save();$('#taskDialog').close();scheduleToday();
}
function loadSettings(){
  $('#weekdayStart').value=state.settings.weekdayStart;
  $('#weekdayEnd').value=state.settings.weekdayEnd;
  $('#weekendStart').value=state.settings.weekendStart;
  $('#weekendEnd').value=state.settings.weekendEnd;
  const min=$('#defaultMinChunk'); if(min)min.value=state.settings.defaultMinChunk||30;
}
function saveSettings(){
  state.settings={
    ...state.settings,
    weekdayStart:$('#weekdayStart').value,
    weekdayEnd:$('#weekdayEnd').value,
    weekendStart:$('#weekendStart').value,
    weekendEnd:$('#weekendEnd').value,
    defaultMinChunk:Number($('#defaultMinChunk')?.value||30)
  };
  save();buildTodayPlanner();
}
function diagnoseStorage(){
  const box=$('#storageDiagnosticResult'); if(!box)return;
  const rows=[];
  const candidates=[];

  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);
    const raw=localStorage.getItem(key);
    let parsed=null;
    try{parsed=JSON.parse(raw)}catch{}

    if(parsed && typeof parsed==='object'){
      const taskCount=Array.isArray(parsed.tasks)?parsed.tasks.length:0;
      const memoCount=Array.isArray(parsed.memoNotes)?parsed.memoNotes.length:0;
      const placementDays=parsed.manualPlacements&&typeof parsed.manualPlacements==='object'?Object.keys(parsed.manualPlacements).length:0;
      if(taskCount||memoCount||placementDays){
        candidates.push({key,taskCount,memoCount,placementDays});
      }
    }
  }

  const currentRaw=localStorage.getItem(STORE_KEY);
  let currentInfo='現在の保存キー「'+STORE_KEY+'」：';
  if(!currentRaw){
    currentInfo+='見つかりません';
  }else{
    try{
      const p=JSON.parse(currentRaw);
      currentInfo+='タスク '+(Array.isArray(p.tasks)?p.tasks.length:0)+'件・付箋 '+(Array.isArray(p.memoNotes)?p.memoNotes.length:0)+'件';
    }catch{
      currentInfo+='データはありますが読み取りに失敗しています';
    }
  }

  rows.push('<p><strong>'+esc(currentInfo)+'</strong></p>');
  const history=readBackupHistory();
  rows.push('<p class="muted">自動バックアップ履歴：'+history.length+' / '+BACKUP_HISTORY_LIMIT+'世代</p>');

  if(candidates.length){
    rows.push('<p>このブラウザ内で、復旧候補になりそうな保存データが見つかりました。</p>');
    rows.push('<div class="storage-candidates">'+candidates.map(x=>
      '<div class="storage-candidate">'+
        '<div><strong>'+esc(x.key)+'</strong><small>タスク '+x.taskCount+'件・付箋 '+x.memoCount+'件</small></div>'+
        (x.key===STORE_KEY?'':'<button type="button" data-restore-storage="'+esc(x.key)+'">このデータを復元</button>')+
      '</div>'
    ).join('')+'</div>');
  }else{
    rows.push('<p>このChromeプロフィールのlocalStorage内には、別のタスクデータ候補は見つかりませんでした。</p>');
    rows.push('<p class="muted">この場合、別のChromeプロフィール・別端末・以前書き出したJSONファイルに残っている可能性があります。</p>');
  }

  box.innerHTML=rows.join('');
  box.classList.remove('hidden');
}

function restoreStorageCandidate(key){
  const raw=localStorage.getItem(key);
  if(!raw)return alert('復元元のデータが見つかりません。');
  let parsed;
  try{parsed=JSON.parse(raw)}catch{return alert('復元元のデータを読み取れませんでした。')}

  const taskCount=Array.isArray(parsed.tasks)?parsed.tasks.length:0;
  const memoCount=Array.isArray(parsed.memoNotes)?parsed.memoNotes.length:0;
  if(!taskCount&&!memoCount)return alert('復元できるタスクや付箋がありません。');

  if(!confirm('タスク '+taskCount+'件・付箋 '+memoCount+'件を現在のSmart Scheduleへ復元しますか？'))return;

  localStorage.setItem(STORE_KEY,raw);
  location.reload();
}

function exportData(){
  const now=new Date();
  const stamp=now.getFullYear()+pad(now.getMonth()+1)+pad(now.getDate())+'-'+pad(now.getHours())+pad(now.getMinutes());
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='smart-schedule-backup-'+stamp+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function importData(file){
  const r=new FileReader();
  r.onload=()=>{
    try{
      const parsed=JSON.parse(r.result);
      if(!parsed||!Array.isArray(parsed.tasks)||!Array.isArray(parsed.memoNotes)){
        throw new Error('Smart Scheduleのバックアップ形式ではありません。');
      }
      state=normalizeLoadedState(parsed);
      persistenceLocked=false;
      loadSafetyReason='';
      if(!save({force:true}))throw new Error('保存に失敗しました。');
      buildTodayPlanner();
      alert('バックアップを読み込みました。');
    }catch(err){
      alert('読み込みに失敗しました。'+(err?.message?'\n'+err.message:''));
    }
  };
  r.readAsText(file);
}
function addDemo(){
  if(state.tasks.length&&!confirm('現在のデータにサンプルを追加しますか？'))return;
  const k=todayKey();const d2=new Date(k+'T12:00:00');d2.setDate(d2.getDate()+3);const end=toDateKey(d2);
  state.tasks.push(
    {id:uuid(),title:'教材作成',notes:'期間タスクの例',category:'仕事',importance:5,duration:180,remainingMinutes:180,intensity:'focus',mode:'range',startDate:k,endDate:end,deadline:end+'T23:59',recurrence:'none',weekdays:[],splittable:true,minChunk:30,maxPerDay:90,locked:false,deferCount:0,completionDates:[],status:'open'},
    {id:uuid(),title:'メール確認',notes:'',category:'仕事',importance:3,duration:30,remainingMinutes:30,intensity:'light',mode:'date',startDate:k,endDate:'',deadline:k+'T22:00',recurrence:'none',weekdays:[],splittable:false,minChunk:30,maxPerDay:30,locked:false,deferCount:0,completionDates:[],status:'open'}
  );save();buildTodayPlanner();
}

function applyViewportScale(){
  const shell=document.querySelector('.app-shell');
  if(!shell)return;
  const designWidth=1440;
  const sidePadding=12;
  const available=Math.max(320,window.innerWidth-sidePadding*2);
  const scale=Math.min(1,available/designWidth);
  document.documentElement.style.setProperty('--app-scale',String(scale));
  document.body.style.minHeight=Math.ceil(shell.scrollHeight*scale)+'px';
}


let deferredInstallPrompt=null;

function isStandaloneMode(){
  return window.matchMedia?.('(display-mode: standalone)').matches ||
         window.navigator.standalone===true;
}

function updateInstallUI(){
  const btn=$('#installAppBtn');
  const status=$('#installAppStatus');
  if(!btn||!status)return;

  if(isStandaloneMode()){
    btn.classList.add('hidden');
    status.textContent='インストール済みです。';
    return;
  }

  if(deferredInstallPrompt){
    btn.classList.remove('hidden');
    status.textContent='この端末にSmart Scheduleを追加できます。';
  }else{
    btn.classList.add('hidden');
    status.textContent='Chromeのメニューから「ページをアプリとしてインストール」も利用できます。';
  }
}

async function installPwa(){
  if(!deferredInstallPrompt)return;
  deferredInstallPrompt.prompt();
  try{
    await deferredInstallPrompt.userChoice;
  }catch{}
  deferredInstallPrompt=null;
  updateInstallUI();
}

function initPwa(){
  if('serviceWorker' in navigator){
    window.addEventListener('load',async()=>{
      try{
        const registration=await navigator.serviceWorker.register('./sw.js?v=18');
        await registration.update();

        let reloading=false;
        navigator.serviceWorker.addEventListener('controllerchange',()=>{
          if(reloading)return;
          reloading=true;
          const key='smartScheduleSwReloadV18';
          if(sessionStorage.getItem(key)!=='1'){
            sessionStorage.setItem(key,'1');
            location.reload();
          }
        });
      }catch(err){
        console.warn('Service Worker registration failed',err);
      }
    });
  }

  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredInstallPrompt=e;
    updateInstallUI();
  });

  window.addEventListener('appinstalled',()=>{
    deferredInstallPrompt=null;
    updateInstallUI();
  });

  const installBtn=$('#installAppBtn');
  if(installBtn)installBtn.addEventListener('click',installPwa);
  updateInstallUI();
}

function safeCloseDialog(){
  const d=$('#taskDialog');
  if(d&&d.open)d.close();
}
function initApp(){
  document.addEventListener('click',e=>{
    const done=e.target.closest('[data-done]');if(done)return completeTask(done.dataset.done,Number(done.dataset.min));
    const progress=e.target.closest('[data-progress]');if(progress)return markProgressToday(progress.dataset.progress);
    const undoDone=e.target.closest('[data-undo-done]');if(undoDone)return undoCompleteTask(undoDone.dataset.undoDone);
    const edit=e.target.closest('[data-edit]');if(edit)return openTask(taskById(edit.dataset.edit));
    const defer=e.target.closest('[data-defer]');if(defer)return deferTask(defer.dataset.defer);
    const shift=e.target.closest('[data-shift]');if(shift)return shiftTask(shift.dataset.shift,Number(shift.dataset.delta));
    const auto=e.target.closest('[data-auto]');if(auto)return clearManualPlacement(auto.dataset.auto);
    const place=e.target.closest('[data-place]');if(place)return promptPlaceTask(place.dataset.place);
    const toggleImportant=e.target.closest('[data-toggle-important]');if(toggleImportant)return toggleMemoImportant(toggleImportant.dataset.toggleImportant);
    const editMemo=e.target.closest('[data-edit-memo]');if(editMemo)return openMemo(state.memoNotes.find(n=>n.id===editMemo.dataset.editMemo));
    const restoreStorage=e.target.closest('[data-restore-storage]');if(restoreStorage)return restoreStorageCandidate(restoreStorage.dataset.restoreStorage);
    const deleteMemoX=e.target.closest('[data-delete-memo]');if(deleteMemoX){
      const id=deleteMemoX.dataset.deleteMemo;
      if(confirm('この付箋を削除しますか？')){
        state.memoNotes=state.memoNotes.filter(n=>n.id!==id);
        save();
        renderMemoBoard();
      }
      return;
    }
  });

  $$('.tab').forEach(b=>b.addEventListener('click',()=>{
    $$('.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    $$('.view').forEach(v=>v.classList.remove('active'));
    const target=$('#view-'+b.dataset.view); if(target)target.classList.add('active');
  }));

  const add=$('#addTaskBtn');
  if(add)add.addEventListener('click',()=>openTask());

  const addMemo=$('#addMemoBtn'); if(addMemo)addMemo.addEventListener('click',()=>openMemo());
  const memoForm=$('#memoForm'); if(memoForm)memoForm.addEventListener('submit',e=>{e.preventDefault();saveMemo()});
  const closeMemo=$('#closeMemoDialogBtn'); if(closeMemo)closeMemo.addEventListener('click',()=>$('#memoDialog').close());
  const cancelMemo=$('#cancelMemoBtn'); if(cancelMemo)cancelMemo.addEventListener('click',()=>$('#memoDialog').close());
  const deleteMemoBtn=$('#deleteMemoBtn'); if(deleteMemoBtn)deleteMemoBtn.addEventListener('click',deleteMemo);

  const dd=$('#dayDoneBtn'); if(dd)dd.addEventListener('click',dayDone);
  const close=$('#closeDialogBtn'); if(close)close.addEventListener('click',safeCloseDialog);
  const cancel=$('#cancelBtn'); if(cancel)cancel.addEventListener('click',safeCloseDialog);
  const del=$('#deleteTaskBtn'); if(del)del.addEventListener('click',deleteTask);
  const mode=$('#scheduleMode'); if(mode)mode.addEventListener('change',()=>{
    if($('#recurrence')?.value==='weekly'){
      mode.value='fixed';
      renderModeFields({startDate:$('#startDate')?.value||todayKey()});
      return;
    }
    renderModeFields({});
  });
  const rec=$('#recurrence'); if(rec)rec.addEventListener('change',()=>{
    const current={
      startDate:$('#startDate')?.value||todayKey(),
      endDate:$('#endDate')?.value||'',
      fixedStart:$('#fixedStart')?.value||'18:00'
    };
    if(rec.value==='weekly')$('#scheduleMode').value='fixed';
    renderModeFields(current);
    renderWeekdays([],current.fixedStart);
  });
  const form=$('#taskForm'); if(form)form.addEventListener('submit',e=>{e.preventDefault();saveTask()});
  $$('#taskFilterTabs [data-task-filter]').forEach(btn=>btn.addEventListener('click',()=>{
    currentTaskFilter=btn.dataset.taskFilter||'normal';
    $$('#taskFilterTabs [data-task-filter]').forEach(x=>{
      const active=x===btn;
      x.classList.toggle('active',active);
      x.setAttribute('aria-selected',active?'true':'false');
    });
    renderAllTasks();
  }));
  const saveBtn=$('#saveSettingsBtn'); if(saveBtn)saveBtn.addEventListener('click',saveSettings);
  const diagnose=$('#diagnoseStorageBtn'); if(diagnose)diagnose.addEventListener('click',diagnoseStorage);
  const exp=$('#exportBtn'); if(exp)exp.addEventListener('click',exportData);
  const imp=$('#importInput'); if(imp)imp.addEventListener('change',e=>e.target.files[0]&&importData(e.target.files[0]));
  const demo=$('#demoBtn'); if(demo)demo.addEventListener('click',addDemo);

  applyViewportScale();
  window.addEventListener('resize',applyViewportScale);
  initPwa();

  try{
    const loadedTasks=Array.isArray(state.tasks)?state.tasks.length:0;
    const loadedMemos=Array.isArray(state.memoNotes)?state.memoNotes.length:0;
    const boot=$('#storageBootStatus');
    if(boot)boot.textContent='保存データ: タスク '+loadedTasks+'件 / 付箋 '+loadedMemos+'件（アプリ読込済み）';
    buildTodayPlanner();
    requestAnimationFrame(applyViewportScale);
    console.info('Smart Schedule loaded',loadedTasks+' tasks',loadedMemos+' memos');
  }catch(err){
    console.error(err);
    const banner=$('#overloadBanner');
    if(banner){
      const tc=Array.isArray(state.tasks)?state.tasks.length:0;
      const mc=Array.isArray(state.memoNotes)?state.memoNotes.length:0;
      banner.textContent='初期表示エラー：'+(err?.message||String(err))+'（保存データ: タスク'+tc+'件・付箋'+mc+'件）';
      banner.classList.remove('hidden');
    }
  }
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',initApp);
}else{
  initApp();
}
