const STORE_KEY='smartScheduleDataV1';
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
  for(const t of state.tasks||[]){
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

function load(){
  try{
    const raw=JSON.parse(localStorage.getItem(STORE_KEY)||'{}')||{};
    return {
      tasks:Array.isArray(raw.tasks)?raw.tasks:[],
      settings:{...defaultState.settings,...(raw.settings||{})},
      completionLog:raw.completionLog&&typeof raw.completionLog==='object'?raw.completionLog:{},
      manualPlacements:raw.manualPlacements&&typeof raw.manualPlacements==='object'?raw.manualPlacements:{},
      completedTimeline:raw.completedTimeline&&typeof raw.completedTimeline==='object'?raw.completedTimeline:{},
      memoNotes:Array.isArray(raw.memoNotes)?raw.memoNotes:[]
    };
  }catch{
    return {
      tasks:[],
      settings:{...defaultState.settings},
      completionLog:{},
      manualPlacements:{},
      completedTimeline:{},
      memoNotes:[]
    };
  }
}
function save(){localStorage.setItem(STORE_KEY,JSON.stringify(state));}
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
function isCompleted(task){
  if(task.recurrence&&task.recurrence!=='none') return false;
  return task.remainingMinutes<=0 || task.status==='done';
}
function taskActiveOn(task,k=todayKey()){
  if(isCompleted(task)||!isRecurringOn(task,new Date(k+'T12:00:00'))) return false;
  if(task.recurrence!=='none' && isDoneToday(task,k)) return false;

  if(task.recurrence&&task.recurrence!=='none'){
    if(task.startDate&&k<task.startDate)return false;
    if(task.mode==='range')return dateInRange(k,task.startDate,task.endDate);
    return true;
  }

  if(task.mode==='fixed'||task.mode==='date') return task.startDate===k;
  if(task.mode==='range') return dateInRange(k,task.startDate,task.endDate);
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
  return (pace>=DAILY_WORKLOAD_ALERT_MINUTES || inLeadWindow) && !placedToday;
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

  const current=todaySchedule.find(e=>e.taskId===taskId);
  const target=todaySchedule.find(e=>e.taskId!==taskId&&overlaps(newStart,newStart+len,e.start,e.end));

  if(target?.fixed){
    alert('固定予定と重なるため、そこには置けません。');
    return;
  }

  const placements=getManualPlacements();
  if(target){
    if(current && !target.fixed){
      placements[target.taskId]=current.start;
    }else{
      alert('すでに別のタスクがあります。空いている時間へ置いてください。');
      return;
    }
  }
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

  const fixed=state.tasks.filter(t=>taskActiveOn(t,k)&&t.mode==='fixed');
  for(const t of fixed){
    const s=timeToMinutes(t.fixedStart||'09:00');
    const len=Math.max(5,t.remainingMinutes??t.duration);
    entries.push({taskId:t.id,start:s,end:s+len,minutes:len,fixed:true,manual:false,priority:'must'});
  }

  const manual=state.tasks
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

  for(const t of state.tasks){
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
  save();
  render();
}

function scheduleToday(){
  buildTodayPlanner();
}
function plannedTaskMinutes(){return todaySchedule.reduce((s,x)=>s+x.minutes,0)}
function taskById(id){return state.tasks.find(t=>t.id===id)}

function render(){
  $('#todayLabel').textContent=new Date().toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
  const active=state.tasks.filter(t=>taskActiveOn(t));
  const done=state.tasks.filter(t=>isDoneToday(t)||isCompleted(t));
  $('#plannedMinutes').textContent=fmtMin(plannedTaskMinutes());
  $('#doneCount').textContent=done.length+' / '+(active.length+done.length);
  $('#mustCount').textContent=active.filter(t=>priorityClass(t)==='must').length+'件';
  const [ws,we]=workWindow(); $('#freeMinutes').textContent=fmtMin(Math.max(0,we-ws-plannedTaskMinutes()));
  renderTimeline();renderMemoBoard();renderTodayTasks();renderAllTasks();renderNext();renderNeglectedTasks();renderOverload();loadSettings();requestAnimationFrame(applyViewportScale);
}
function renderNeglectedTasks(){
  const section=$('#neglectedSection');
  const box=$('#neglectedTasks');
  const count=$('#neglectedCount');
  if(!section||!box||!count)return;

  const items=state.tasks
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
  if(el)el.classList.add('hidden');
}
function renderTimeline(){
  const box=$('#timeline');
  const [ws,we]=workWindow();
  const pxPer30=48;
  const totalHeight=Math.max(96,((we-ws)/30)*pxPer30);

  const trayTasks=state.tasks
    .filter(t=>taskActiveOn(t)&&t.mode!=='fixed'&&!isManualPlaced(t.id))
    .sort((a,b)=>priority(b)-priority(a));

  const tray=trayTasks.length
    ? trayTasks.map(t=>'<div class="task-sticky" data-tray-task="'+t.id+'" tabindex="0">'+
        '<span class="sticky-title">'+esc(t.title)+'</span>'+
        '<span class="sticky-meta">'+fmtMin(t.remainingMinutes??t.duration)+' ・ '+'★'.repeat(t.importance||3)+(deadlineLabel(t)?' ・ '+deadlineLabel(t):'')+'</span>'+
        '<button type="button" data-place="'+t.id+'" title="時刻を入力して配置">配置</button>'+
      '</div>').join('')
    : '<div class="tray-empty">今日の未配置タスクはありません。</div>';

  let labels='';
  for(let m=ws;m<=we;m+=30){
    const major=m%60===0;
    labels+='<div class="planner-time '+(major?'major':'')+'" style="top:'+(((m-ws)/30)*pxPer30)+'px">'+(major?minutesToTime(m):'')+'</div>';
  }

  let cards='';
  for(const e of todaySchedule){
    if(e.start<ws||e.start>=we)continue;
    const top=((e.start-ws)/30)*pxPer30;
    const height=Math.max(18,((e.end-e.start)/30)*pxPer30);
    const t=taskById(e.taskId); if(!t)continue;
    const cls=e.fixed?'fixed':'manual';
    const compact=e.minutes<=30?' compact':'';
    const completed=e.completed?' completed':'';
    cards+='<article class="planner-task '+cls+compact+completed+'" data-planner-task="'+t.id+'" style="top:'+top+'px;height:'+height+'px">'+
      '<button type="button" class="drag-handle" data-drag="'+t.id+'" aria-label="'+esc(t.title)+'を時間移動">⋮⋮</button>'+
      '<div class="planner-task-time">'+minutesToTime(e.start)+'〜'+minutesToTime(e.end)+'</div>'+
      '<div class="planner-task-body"><b>'+esc(t.title)+'</b><div class="meta">'+fmtMin(e.minutes)+(deadlineLabel(t)?' ・ '+deadlineLabel(t):'')+'</div></div>'+
      '<div class="planner-task-actions">'+
        (e.completed
          ? ''
          : ((!e.fixed?'<button type="button" data-shift="'+t.id+'" data-delta="-30">−30</button><button type="button" data-shift="'+t.id+'" data-delta="30">+30</button><button type="button" data-auto="'+t.id+'">戻す</button>':'')+
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
    sticky.addEventListener('pointerdown',e=>{
      if(e.target.closest('button'))return;
      if(e.button!==undefined&&e.button!==0)return;
      const id=sticky.dataset.trayTask;
      const t=taskById(id); if(!t)return;
      e.preventDefault();

      const ghost=document.createElement('div');
      ghost.className='sticky-ghost';
      ghost.textContent=t.title+' ・ '+fmtMin(t.remainingMinutes??t.duration);
      document.body.appendChild(ghost);

      const move=ev=>{
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
function memoColorClass(color){
  return ['red','yellow','green','blue'].includes(color)?color:'green';
}

function renderMemoBoard(){
  const board=$('#memoBoard'); if(!board)return;
  board.innerHTML='';
  const notes=Array.isArray(state.memoNotes)?state.memoNotes:[];
  const maxW=Math.max(260,board.clientWidth||360);

  for(const note of notes){
    const el=document.createElement('article');
    el.className='memo-note memo-'+memoColorClass(note.color);
    el.dataset.memoId=note.id;

    const w=Math.max(180,Math.min(Number(note.w)||260,maxW-12));
    const h=Math.max(88,Number(note.h)||115);
    const x=Math.max(0,Math.min(Number(note.x)||10,Math.max(0,maxW-w-6)));
    const y=Math.max(0,Number(note.y)||10);

    note.w=w;note.h=h;note.x=x;note.y=y;
    el.style.left=x+'px';
    el.style.top=y+'px';
    el.style.width=w+'px';
    el.style.height=h+'px';

    el.innerHTML=
      '<div class="memo-note-bar" data-memo-drag="'+note.id+'">'+
        '<span class="memo-grip">⋮⋮</span>'+
        '<span class="memo-note-label">付箋</span>'+
        '<div class="memo-note-actions">'+
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

  setupMemoDragging();
  setupMemoResizing();
  save();
}

function openMemo(note=null){
  $('#memoForm').reset();
  $('#memoId').value=note?.id||'';
  $('#memoDialogTitle').textContent=note?'付箋を編集':'付箋を作成';
  $('#memoText').value=note?.text||'';
  const color=note?.color||'green';
  const radio=document.querySelector('input[name="memoColor"][value="'+color+'"]');
  if(radio)radio.checked=true;
  $('#deleteMemoBtn').classList.toggle('hidden',!note);
  $('#memoDialog').showModal();
  setTimeout(()=>$('#memoText')?.focus(),0);
}

function saveMemo(){
  const id=$('#memoId').value;
  const textValue=$('#memoText').value.trim();
  if(!textValue)return;
  const color=document.querySelector('input[name="memoColor"]:checked')?.value||'green';
  const old=id?state.memoNotes.find(n=>n.id===id):null;

  if(old){
    old.text=textValue;
    old.color=color;
  }else{
    const count=state.memoNotes.length;
    state.memoNotes.push({
      id:uuid(),
      text:textValue,
      color,
      x:12+(count%3)*28,
      y:12+(count%5)*26,
      w:260,
      h:115,
      createdAt:new Date().toISOString()
    });
  }
  save();
  $('#memoDialog').close();
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

      e.preventDefault();
      bar.setPointerCapture?.(e.pointerId);
      const rect=board.getBoundingClientRect();
      const scaleX=rect.width/Math.max(1,board.offsetWidth);
      const scaleY=rect.height/Math.max(1,board.offsetHeight);
      const startX=e.clientX;
      const startY=e.clientY;
      const originalX=Number(note.x)||0;
      const originalY=Number(note.y)||0;
      el.classList.add('moving');

      const move=ev=>{
        const maxX=Math.max(0,board.offsetWidth-el.offsetWidth);
        const maxY=Math.max(0,board.offsetHeight-el.offsetHeight);
        const dx=(ev.clientX-startX)/Math.max(.01,scaleX);
        const dy=(ev.clientY-startY)/Math.max(.01,scaleY);
        const x=Math.max(0,Math.min(maxX,originalX+dx));
        const y=Math.max(0,Math.min(maxY,originalY+dy));
        el.style.left=x+'px';
        el.style.top=y+'px';
      };
      const up=ev=>{
        bar.releasePointerCapture?.(e.pointerId);
        bar.removeEventListener('pointermove',move);
        bar.removeEventListener('pointerup',up);
        bar.removeEventListener('pointercancel',up);
        el.classList.remove('moving');
        const maxX=Math.max(0,board.offsetWidth-el.offsetWidth);
        const maxY=Math.max(0,board.offsetHeight-el.offsetHeight);
        const dx=(ev.clientX-startX)/Math.max(.01,scaleX);
        const dy=(ev.clientY-startY)/Math.max(.01,scaleY);
        note.x=Math.round(Math.max(0,Math.min(maxX,originalX+dx)));
        note.y=Math.round(Math.max(0,Math.min(maxY,originalY+dy)));
        save();
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
  const pending=todaySchedule.filter(e=>!e.completed && !isDoneToday(taskById(e.taskId)) && !isCompleted(taskById(e.taskId)));
  const e=pending.find(x=>x.end>=m)||pending[0];
  const box=$('#nextTask');
  if(!e){box.innerHTML='<div class="empty">次の予定はありません。</div>';return}
  const t=taskById(e.taskId);
  if(!t){box.innerHTML='<div class="empty">次の予定はありません。</div>';return}
  box.innerHTML='<div class="next-box"><div><strong>'+esc(t.title)+'</strong><div class="meta">'+minutesToTime(e.start)+'〜'+minutesToTime(e.end)+' ・ '+labelPriority(t)+'</div></div><button class="primary" data-done="'+t.id+'" data-min="'+e.minutes+'">完了</button></div>';
}
function taskCard(t,today=false){
  const rem=Math.max(0,t.remainingMinutes??t.duration);
  const deadline=t.endDate|| (t.deadline?t.deadline.slice(0,10):'');
  const dLabel=deadlineLabel(t);
  const dClass=deadlineClass(t);
  const neglected=isNeglectedTask(t);
  return '<article class="task-card '+(isCompleted(t)?'done':'')+(neglected?' neglected':'')+'"><div><h3>'+esc(t.title)+'</h3><div class="task-tags"><span class="tag '+(priorityClass(t)==='must'?'red':priorityClass(t)==='recommended'?'orange':'blue')+'">'+labelPriority(t)+'</span><span class="tag">'+'★'.repeat(t.importance||3)+'</span><span class="tag">残り '+fmtMin(rem)+'</span>'+(dLabel?'<span class="tag deadline-tag '+dClass+'">'+esc(dLabel)+'</span>':'')+(neglected?'<span class="tag neglected-tag">放置中</span>':'')+(t.deferCount?'<span class="tag">延期 '+t.deferCount+'回</span>':'')+'</div></div><div class="card-actions">'+(!isCompleted(t)?'<button data-done="'+t.id+'" data-min="'+Math.min(rem,targetForToday(t))+'">完了</button><button data-defer="'+t.id+'">延期</button>':'')+'<button data-edit="'+t.id+'">編集</button></div></article>';
}
function renderTodayTasks(){
  const a=state.tasks.filter(t=>taskActiveOn(t)).sort((x,y)=>priority(y)-priority(x));
  $('#todayTasks').innerHTML=a.length?a.map(t=>taskCard(t,true)).join(''):'<div class="empty">今日のタスクはありません。</div>';
}
function renderAllTasks(){
  const f=$('#taskFilter')?.value||'open';
  let a=[...state.tasks];
  if(f==='open')a=a.filter(t=>!isCompleted(t)); if(f==='done')a=a.filter(t=>isCompleted(t));
  a.sort((x,y)=>priority(y)-priority(x));
  $('#allTasks').innerHTML=a.length?a.map(t=>taskCard(t)).join(''):'<div class="empty">該当するタスクはありません。</div>';
}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

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
  const spl=$('#splittable'); if(spl)spl.checked=t?.splittable??false;
  const min=$('#minChunk'); if(min)min.value=t?.minChunk||state.settings.defaultMinChunk;
  const max=$('#maxPerDay'); if(max)max.value=t?.maxPerDay||120;
  const lock=$('#locked'); if(lock)lock.checked=t?.locked||false;
  renderModeFields(t);renderWeekdays(t?.weekdays||[]);
  $('#taskDialog').showModal();
}
function renderModeFields(t={}){
  t=t||{};
  const mode=$('#scheduleMode').value;const box=$('#modeFields');
  const recurring=($('#recurrence')?.value||t.recurrence||'none')!=='none';
  if(mode==='fixed'){
    const dateLabel=recurring?'繰り返し開始日':'日付';
    box.innerHTML='<div class="form-grid"><label>'+dateLabel+'<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>開始時刻<input id="fixedStart" type="time" value="'+(t.fixedStart||'18:00')+'"></label></div>';
  }
  else if(mode==='date')box.innerHTML='<label>'+(recurring?'繰り返し開始日':'実施日')+'<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label>';
  else if(mode==='range')box.innerHTML='<div class="form-grid"><label>開始日<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>終了日<input id="endDate" type="date" value="'+(t.endDate||todayKey())+'"></label></div>';
  else box.innerHTML='<label>開始可能日（任意）<input id="startDate" type="date" value="'+(t.startDate||'')+'"></label>';
}
function renderWeekdays(selected=[]){
  const box=$('#weekdayPicker');const show=$('#recurrence').value==='weekly';box.classList.toggle('hidden',!show);
  box.innerHTML=show
    ? '<div class="weekday-help">実行する曜日を選択</div>'+WEEKDAYS.map((d,i)=>'<label><input type="checkbox" value="'+i+'" '+(selected.includes(i)?'checked':'')+'> '+d+'</label>').join('')
    : '';
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
    locked:$('#locked')?.checked??false,deferCount:old?.deferCount||0,completionDates:old?.completionDates||[],
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
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='smart-schedule-backup.json';a.click();URL.revokeObjectURL(a.href);
}
function importData(file){
  const r=new FileReader();r.onload=()=>{try{state=JSON.parse(r.result);save();buildTodayPlanner();alert('読み込みました。')}catch{alert('読み込みに失敗しました。')}};r.readAsText(file);
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
    window.addEventListener('load',()=>{
      navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service Worker registration failed',err));
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
    const undoDone=e.target.closest('[data-undo-done]');if(undoDone)return undoCompleteTask(undoDone.dataset.undoDone);
    const edit=e.target.closest('[data-edit]');if(edit)return openTask(taskById(edit.dataset.edit));
    const defer=e.target.closest('[data-defer]');if(defer)return deferTask(defer.dataset.defer);
    const shift=e.target.closest('[data-shift]');if(shift)return shiftTask(shift.dataset.shift,Number(shift.dataset.delta));
    const auto=e.target.closest('[data-auto]');if(auto)return clearManualPlacement(auto.dataset.auto);
    const place=e.target.closest('[data-place]');if(place)return promptPlaceTask(place.dataset.place);
    const editMemo=e.target.closest('[data-edit-memo]');if(editMemo)return openMemo(state.memoNotes.find(n=>n.id===editMemo.dataset.editMemo));
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
  const mode=$('#scheduleMode'); if(mode)mode.addEventListener('change',()=>renderModeFields({}));
  const rec=$('#recurrence'); if(rec)rec.addEventListener('change',()=>{
    const current={
      startDate:$('#startDate')?.value||todayKey(),
      endDate:$('#endDate')?.value||'',
      fixedStart:$('#fixedStart')?.value||'18:00'
    };
    renderWeekdays([]);
    renderModeFields(current);
  });
  const form=$('#taskForm'); if(form)form.addEventListener('submit',e=>{e.preventDefault();saveTask()});
  const filter=$('#taskFilter'); if(filter)filter.addEventListener('change',renderAllTasks);
  const saveBtn=$('#saveSettingsBtn'); if(saveBtn)saveBtn.addEventListener('click',saveSettings);
  const exp=$('#exportBtn'); if(exp)exp.addEventListener('click',exportData);
  const imp=$('#importInput'); if(imp)imp.addEventListener('change',e=>e.target.files[0]&&importData(e.target.files[0]));
  const demo=$('#demoBtn'); if(demo)demo.addEventListener('click',addDemo);

  applyViewportScale();
  window.addEventListener('resize',applyViewportScale);
  initPwa();

  try{
    buildTodayPlanner();
    requestAnimationFrame(applyViewportScale);
  }catch(err){
    console.error(err);
    const banner=$('#overloadBanner');
    if(banner){
      banner.textContent='初期表示でエラーが発生しました。設定データを確認してください。';
      banner.classList.remove('hidden');
    }
  }
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',initApp);
}else{
  initApp();
}
