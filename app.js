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
  settings:{weekdayStart:'16:00',weekdayEnd:'23:00',weekendStart:'09:00',weekendEnd:'23:00',defaultMinChunk:30,autoBreaks:true,breakMinutes:15},
  completionLog:{}
};
let state=load();
let todaySchedule=[];

function load(){
  try{return {...defaultState,...JSON.parse(localStorage.getItem(STORE_KEY)||'{}')};}
  catch{return structuredClone(defaultState);}
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
function scheduleToday(){
  const k=todayKey();
  let [start,end]=workWindow();
  let slots=[[start,end]],entries=[];
  const fixed=state.tasks.filter(t=>taskActiveOn(t,k)&&t.mode==='fixed');
  for(const t of fixed){
    const s=timeToMinutes(t.fixedStart||'09:00');
    const len=Math.max(5,t.remainingMinutes??t.duration);
    const e=Math.min(1440,s+len);
    entries.push({taskId:t.id,start:s,end:e,minutes:e-s,fixed:true,priority:'must'});
    slots=subtractSlot(slots,s,e);
  }

  const candidates=state.tasks.filter(t=>taskActiveOn(t,k)&&t.mode!=='fixed')
    .sort((a,b)=>priority(b)-priority(a));

  const nonSplit=candidates.filter(t=>!t.splittable);
  const split=candidates.filter(t=>t.splittable);
  const placeOne=(t,want)=>{
    const pick=bestSlot(slots,want); if(!pick)return 0;
    const s=pick.s[0],e=s+want;
    entries.push({taskId:t.id,start:s,end:e,minutes:want,fixed:false,priority:priorityClass(t)});
    slots=subtractSlot(slots,s,e); return want;
  };

  for(const t of nonSplit){
    const need=Math.max(5,t.remainingMinutes??t.duration);
    placeOne(t,need);
  }
  for(const t of split){
    let want=targetForToday(t);
    const min=Math.min(want,t.minChunk||state.settings.defaultMinChunk);
    let placed=0;
    while(want-placed>=min){
      const chunk=Math.min(want-placed,60);
      const possible=slots.some(([a,b])=>b-a>=chunk)?chunk:min;
      const p=placeOne(t,possible); if(!p)break; placed+=p;
    }
  }

  entries.sort((a,b)=>a.start-b.start);

  if(state.settings.autoBreaks){
    const withBreaks=[]; let continuous=0;
    for(const e of entries){
      if(withBreaks.length && e.start-withBreaks[withBreaks.length-1].end>=state.settings.breakMinutes) continuous=0;
      withBreaks.push(e); continuous+=e.minutes;
      if(continuous>=90){
        const br=state.settings.breakMinutes;
        const gapStart=e.end;
        const next=entries.find(x=>x.start>=gapStart);
        if(!next || next.start-gapStart>=br){withBreaks.push({break:true,start:gapStart,end:gapStart+br,minutes:br});continuous=0;}
      }
    }
    entries=withBreaks.sort((a,b)=>a.start-b.start);
  }
  todaySchedule=entries;
  render();
}
function plannedTaskMinutes(){return todaySchedule.filter(x=>!x.break).reduce((s,x)=>s+x.minutes,0)}
function taskById(id){return state.tasks.find(t=>t.id===id)}

function render(){
  $('#todayLabel').textContent=new Date().toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
  const active=state.tasks.filter(t=>taskActiveOn(t));
  const done=state.tasks.filter(t=>isDoneToday(t)||isCompleted(t));
  $('#plannedMinutes').textContent=fmtMin(plannedTaskMinutes());
  $('#doneCount').textContent=done.length+' / '+(active.length+done.length);
  $('#mustCount').textContent=active.filter(t=>priorityClass(t)==='must').length+'件';
  const [ws,we]=workWindow(); $('#freeMinutes').textContent=fmtMin(Math.max(0,we-ws-plannedTaskMinutes()));
  renderTimeline();renderTodayTasks();renderAllTasks();renderNext();renderOverload();loadSettings();
}
function renderOverload(){
  const active=state.tasks.filter(t=>taskActiveOn(t));
  const required=active.filter(t=>priorityClass(t)==='must').reduce((s,t)=>s+Math.min(t.remainingMinutes??t.duration,targetForToday(t)),0);
  const [a,b]=workWindow(); const avail=b-a;
  const el=$('#overloadBanner');
  if(required>avail){el.textContent='⚠ 今日必須の作業が、作業可能時間を '+fmtMin(required-avail)+' 超えています。締切・分割・作業時間を見直してください。';el.classList.remove('hidden')}
  else el.classList.add('hidden');
}
function renderTimeline(){
  const box=$('#timeline');box.innerHTML='';
  if(!todaySchedule.length){box.innerHTML='<div class="empty">今日の予定はまだありません。</div>';return}
  for(const e of todaySchedule){
    if(e.break){box.insertAdjacentHTML('beforeend','<div class="timeline-item"><div class="time">'+minutesToTime(e.start)+'–'+minutesToTime(e.end)+'</div><div><b>休憩</b></div></div>');continue}
    const t=taskById(e.taskId);if(!t)continue;
    const cls=e.fixed?'fixed':e.priority;
    const div=document.createElement('div');div.className='timeline-item '+cls;
    div.innerHTML='<div class="time">'+minutesToTime(e.start)+'–'+minutesToTime(e.end)+'</div><div><b>'+esc(t.title)+'</b><div class="meta">'+esc(t.category||'')+' ・ '+fmtMin(e.minutes)+'</div></div><div class="card-actions"><button data-done="'+t.id+'" data-min="'+e.minutes+'">完了</button><button data-edit="'+t.id+'">編集</button></div>';
    box.appendChild(div);
  }
}
function renderNext(){
  const now=new Date();const m=now.getHours()*60+now.getMinutes();
  const e=todaySchedule.find(x=>!x.break&&x.end>=m)||todaySchedule.find(x=>!x.break);
  const box=$('#nextTask');
  if(!e){box.innerHTML='<div class="empty">次の予定はありません。</div>';return}
  const t=taskById(e.taskId);
  box.innerHTML='<div class="next-box"><div><strong>'+esc(t.title)+'</strong><div class="meta">'+minutesToTime(e.start)+'〜'+minutesToTime(e.end)+' ・ '+labelPriority(t)+'</div></div><button class="primary" data-done="'+t.id+'" data-min="'+e.minutes+'">完了</button></div>';
}
function taskCard(t,today=false){
  const rem=Math.max(0,t.remainingMinutes??t.duration);
  const deadline=t.endDate|| (t.deadline?t.deadline.slice(0,10):'');
  return '<article class="task-card '+(isCompleted(t)?'done':'')+'"><div><h3>'+esc(t.title)+'</h3><div class="task-tags"><span class="tag '+(priorityClass(t)==='must'?'red':priorityClass(t)==='recommended'?'orange':'blue')+'">'+labelPriority(t)+'</span><span class="tag">'+'★'.repeat(t.importance||3)+'</span><span class="tag">残り '+fmtMin(rem)+'</span>'+(deadline?'<span class="tag">'+esc(deadline)+'</span>':'')+(t.deferCount?'<span class="tag">延期 '+t.deferCount+'回</span>':'')+'</div></div><div class="card-actions">'+(!isCompleted(t)?'<button data-done="'+t.id+'" data-min="'+Math.min(rem,targetForToday(t))+'">完了</button><button data-defer="'+t.id+'">延期</button>':'')+'<button data-edit="'+t.id+'">編集</button></div></article>';
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
  if(t.recurrence&&t.recurrence!=='none'){
    t.completionDates=[...(t.completionDates||[]).filter(x=>x!==todayKey()),todayKey()];
  }else{
    t.remainingMinutes=Math.max(0,(t.remainingMinutes??t.duration)-Number(minutes||t.duration));
    if(t.remainingMinutes<=0)t.status='done';
  }
  state.completionLog[todayKey()]=(state.completionLog[todayKey()]||0)+Number(minutes||0);
  save();scheduleToday();
}
function deferTask(id){
  const t=taskById(id);if(!t)return;t.deferCount=(t.deferCount||0)+1;
  if(t.mode==='date'){
    const d=new Date((t.startDate||todayKey())+'T12:00:00');d.setDate(d.getDate()+1);t.startDate=toDateKey(d);
  }
  save();scheduleToday();
}
function dayDone(){
  for(const e of todaySchedule.filter(x=>!x.break)){
    const t=taskById(e.taskId);if(t&&!isCompleted(t)){t.deferCount=(t.deferCount||0)+1}
  }
  save();scheduleToday();alert('未完了タスクを明日以降の再配置対象にしました。');
}

function openTask(t=null){
  $('#taskForm').reset();$('#taskId').value=t?.id||'';$('#dialogTitle').textContent=t?'タスク編集':'タスク追加';
  $('#deleteTaskBtn').classList.toggle('hidden',!t);
  $('#title').value=t?.title||'';$('#notes').value=t?.notes||'';$('#category').value=t?.category||'';
  $('#importance').value=t?.importance||3;$('#duration').value=t?.duration||30;$('#intensity').value=t?.intensity||'normal';
  $('#scheduleMode').value=t?.mode||'auto';$('#deadline').value=t?.deadline||'';
  $('#recurrence').value=t?.recurrence||'none';$('#splittable').checked=t?.splittable??true;
  $('#minChunk').value=t?.minChunk||state.settings.defaultMinChunk;$('#maxPerDay').value=t?.maxPerDay||120;$('#locked').checked=t?.locked||false;
  renderModeFields(t);renderWeekdays(t?.weekdays||[]);
  $('#taskDialog').showModal();
}
function renderModeFields(t={}){
  const mode=$('#scheduleMode').value;const box=$('#modeFields');
  if(mode==='fixed')box.innerHTML='<div class="form-grid"><label>日付<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>開始時刻<input id="fixedStart" type="time" value="'+(t.fixedStart||'18:00')+'"></label></div>';
  else if(mode==='date')box.innerHTML='<label>実施日<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label>';
  else if(mode==='range')box.innerHTML='<div class="form-grid"><label>開始日<input id="startDate" type="date" value="'+(t.startDate||todayKey())+'"></label><label>終了日<input id="endDate" type="date" value="'+(t.endDate||todayKey())+'"></label></div>';
  else box.innerHTML='<label>開始可能日（任意）<input id="startDate" type="date" value="'+(t.startDate||'')+'"></label>';
}
function renderWeekdays(selected=[]){
  const box=$('#weekdayPicker');const show=$('#recurrence').value==='weekly';box.classList.toggle('hidden',!show);
  box.innerHTML=WEEKDAYS.map((d,i)=>'<label><input type="checkbox" value="'+i+'" '+(selected.includes(i)?'checked':'')+'> '+d+'</label>').join('');
}
function saveTask(){
  const id=$('#taskId').value;const old=id?taskById(id):null;
  const duration=Number($('#duration').value||30);
  const t={
    id:id||uuid(),title:$('#title').value.trim(),notes:$('#notes').value.trim(),category:$('#category').value.trim(),
    importance:Number($('#importance').value),duration,intensity:$('#intensity').value,mode:$('#scheduleMode').value,
    startDate:$('#startDate')?.value||'',endDate:$('#endDate')?.value||'',fixedStart:$('#fixedStart')?.value||'',
    deadline:$('#deadline').value,recurrence:$('#recurrence').value,
    weekdays:$$('#weekdayPicker input:checked').map(x=>Number(x.value)),
    splittable:$('#splittable').checked,minChunk:Number($('#minChunk').value||30),maxPerDay:Number($('#maxPerDay').value||120),
    locked:$('#locked').checked,deferCount:old?.deferCount||0,completionDates:old?.completionDates||[],
    remainingMinutes:old?Math.min(old.remainingMinutes??duration,duration):duration,status:old?.status||'open',createdAt:old?.createdAt||new Date().toISOString()
  };
  if(old)Object.assign(old,t);else state.tasks.push(t);
  save();$('#taskDialog').close();scheduleToday();
}
function deleteTask(){
  const id=$('#taskId').value;if(!id)return;if(!confirm('このタスクを削除しますか？'))return;
  state.tasks=state.tasks.filter(t=>t.id!==id);save();$('#taskDialog').close();scheduleToday();
}
function loadSettings(){
  $('#weekdayStart').value=state.settings.weekdayStart;$('#weekdayEnd').value=state.settings.weekdayEnd;
  $('#weekendStart').value=state.settings.weekendStart;$('#weekendEnd').value=state.settings.weekendEnd;
  $('#defaultMinChunk').value=state.settings.defaultMinChunk;$('#autoBreaks').checked=state.settings.autoBreaks;$('#breakMinutes').value=state.settings.breakMinutes;
}
function saveSettings(){
  state.settings={weekdayStart:$('#weekdayStart').value,weekdayEnd:$('#weekdayEnd').value,weekendStart:$('#weekendStart').value,weekendEnd:$('#weekendEnd').value,defaultMinChunk:Number($('#defaultMinChunk').value||30),autoBreaks:$('#autoBreaks').checked,breakMinutes:Number($('#breakMinutes').value||15)};
  save();scheduleToday();
}
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='smart-schedule-backup.json';a.click();URL.revokeObjectURL(a.href);
}
function importData(file){
  const r=new FileReader();r.onload=()=>{try{state=JSON.parse(r.result);save();scheduleToday();alert('読み込みました。')}catch{alert('読み込みに失敗しました。')}};r.readAsText(file);
}
function addDemo(){
  if(state.tasks.length&&!confirm('現在のデータにサンプルを追加しますか？'))return;
  const k=todayKey();const d2=new Date(k+'T12:00:00');d2.setDate(d2.getDate()+3);const end=toDateKey(d2);
  state.tasks.push(
    {id:uuid(),title:'教材作成',notes:'期間タスクの例',category:'仕事',importance:5,duration:180,remainingMinutes:180,intensity:'focus',mode:'range',startDate:k,endDate:end,deadline:end+'T23:59',recurrence:'none',weekdays:[],splittable:true,minChunk:30,maxPerDay:90,locked:false,deferCount:0,completionDates:[],status:'open'},
    {id:uuid(),title:'メール確認',notes:'',category:'仕事',importance:3,duration:30,remainingMinutes:30,intensity:'light',mode:'date',startDate:k,endDate:'',deadline:k+'T22:00',recurrence:'none',weekdays:[],splittable:false,minChunk:30,maxPerDay:30,locked:false,deferCount:0,completionDates:[],status:'open'}
  );save();scheduleToday();
}

document.addEventListener('click',e=>{
  const done=e.target.closest('[data-done]');if(done)return completeTask(done.dataset.done,Number(done.dataset.min));
  const edit=e.target.closest('[data-edit]');if(edit)return openTask(taskById(edit.dataset.edit));
  const defer=e.target.closest('[data-defer]');if(defer)return deferTask(defer.dataset.defer);
});
$$('.tab').forEach(b=>b.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.view').forEach(v=>v.classList.remove('active'));$('#view-'+b.dataset.view).classList.add('active')});
$('#addTaskBtn').onclick=()=>openTask();$('#rescheduleBtn').onclick=scheduleToday;$('#dayDoneBtn').onclick=dayDone;
$('#closeDialogBtn').onclick=()=>$('#taskDialog').close();$('#cancelBtn').onclick=()=>$('#taskDialog').close();$('#deleteTaskBtn').onclick=deleteTask;
$('#scheduleMode').onchange=()=>renderModeFields({});$('#recurrence').onchange=()=>renderWeekdays([]);
$('#taskForm').onsubmit=e=>{e.preventDefault();saveTask()};$('#taskFilter').onchange=renderAllTasks;$('#saveSettingsBtn').onclick=saveSettings;
$('#exportBtn').onclick=exportData;$('#importInput').onchange=e=>e.target.files[0]&&importData(e.target.files[0]);$('#demoBtn').onclick=addDemo;

scheduleToday();
