/* Weekly Chore Chart - shared JSON database (Firebase Realtime Database). No secrets in this file. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const cfg=window.CHORE_CONFIG||{};
const ME_KEY="choreMe", BACKUP_KEY="choreLastBackup";
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}};
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg,type){const t=$("toast");t.textContent=msg;t.className="toast show "+(type||"");clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove("show"),type==="err"?5500:2400)}
function fmtMin(m){m=Number(m)||0;const h=Math.floor(m/60),r=m%60;return h?(r?h+"h "+r+"m":h+"h"):r+"m"}
function fmtDate(s){if(!s)return"";const a=String(s).split("-").map(Number);return new Date(a[0],a[1]-1,a[2]).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}
function fmtDT(ms){return new Date(ms).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
function isoDate(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function weekTarget(weekday){const d=new Date();d.setDate(d.getDate()-(((d.getDay()+6)%7+1-weekday+7)%7));return isoDate(d)} // most recent chosen weekday (1=Mon..7=Sun)
const banner=$("banner");
const showBanner=m=>{banner.hidden=false;banner.innerHTML=m};
const hideBanner=()=>{banner.hidden=true};

const fc=cfg.firebase||{};
if(!window.firebase||!fc.apiKey||/YOUR-/.test(fc.apiKey+fc.databaseURL)){
  showBanner("<strong>Setup needed.</strong> Open <code>config.js</code> and paste your Firebase web-app config (see README, step 4)."+(window.firebase?"":" The Firebase library also failed to load — check your internet connection."));
  $("progressText").textContent="Not connected";return;
}
firebase.initializeApp(fc);
const db=firebase.database(), auth=firebase.auth();
try{auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)}catch(e){}
const SERVER_TS=firebase.database.ServerValue.TIMESTAMP;

/* ---------- state ---------- */
const S={settings:null,members:[],tasks:[],comps:[],ready:false};
const raw={settings:null,members:null,tasks:null,completions:null};
const loaded={settings:false,members:false,tasks:false,completions:false};
let compKeys=new Set(), connected=false;
let me=lsGet(ME_KEY)||"", tab="mine", histFilter="all", adminTab="summary", recFilter={member:"",kind:"",scope:"week"};
let adminUser=null, isAdmin=false, busy=new Set();

const member=id=>S.members.find(m=>m.id===id);
const mname=id=>{const m=member(id);return m?m.name:"Unknown"};
const who=c=>member(c.member)?member(c.member).name:c.memberName;
const cur=()=>S.settings.currency;
const moneyC=c=>cur()+((Number(c)||0)/100).toFixed(2);
const rate=()=>S.settings.rateCents;
const payFor=(min,rc)=>Math.round(min*rc/60);

function derive(){
  S.settings=raw.settings;
  S.members=Object.keys(raw.members||{}).sort().map(k=>Object.assign({id:k},raw.members[k]));
  S.tasks=Object.keys(raw.tasks||{}).map(k=>Object.assign({id:k},raw.tasks[k])).sort((a,b)=>(a.order||0)-(b.order||0));
  const c=raw.completions||{};
  compKeys=new Set(Object.keys(c));
  S.comps=Object.keys(c).map(k=>Object.assign({key:k},c[k])).sort((a,b)=>(Number(b.at)||0)-(Number(a.at)||0));
}
const claimOf=t=>t.claim&&t.claim.week===S.settings.weekId?t.claim.member:null;
const weekComps=()=>S.comps.filter(c=>c.week===S.settings.weekId&&!c.voided);
const countFor=id=>weekComps().filter(c=>c.task===id).length;
const latestMine=id=>weekComps().filter(c=>c.task===id&&c.member===me)[0];
const regularTasks=()=>S.tasks.filter(t=>t.active&&t.kind==="regular");

function totals(){
  const wk=weekComps();
  return S.members.map(m=>{
    const mine=wk.filter(c=>c.member===m.id),wkPaid=mine.filter(c=>c.kind==="paid");
    const allPaid=S.comps.filter(c=>c.member===m.id&&c.kind==="paid"&&!c.voided);
    const sum=(a,f)=>a.reduce((x,c)=>x+(Number(c[f])||0),0);
    return{id:m.id,points:S.settings.startPoints+sum(mine,"points"),regDone:mine.filter(c=>c.kind==="regular").length,
      assigned:regularTasks().filter(t=>claimOf(t)===m.id).length,
      weekEarn:sum(wkPaid,"paymentCents"),weekMin:sum(wkPaid,"minutes"),weekJobs:wkPaid.length,
      allEarn:sum(allPaid,"paymentCents"),allMin:sum(allPaid,"minutes"),allJobs:allPaid.length};
  });
}

/* ---------- write helpers (a change is "saved" only after the server confirms) ---------- */
class AppError extends Error{constructor(m,code){super(m);this.code=code}}
async function write(fn){
  if(!connected)throw new AppError("You’re offline. Your change was NOT saved.","net");
  let timer;
  const timeout=new Promise((_,rej)=>{timer=setTimeout(()=>rej(new AppError("The database did not confirm in time. Check your connection and refresh before trying again.","timeout")),10000)});
  try{return await Promise.race([fn(),timeout])}
  catch(e){
    if(e instanceof AppError)throw e;
    if(e&&(e.code==="PERMISSION_DENIED"||/permission_denied/i.test(e.message||"")))throw new AppError("The database refused this change — it may already be done, someone else got there first, or the rules don’t allow it.","denied");
    throw new AppError((e&&e.message)||"Save failed","err");
  }finally{clearTimeout(timer)}
}
const reportError=e=>toast(e.message||String(e),"err");
async function adminWrite(fn,okMsg){
  if(!isAdmin){toast("Please log in as admin first.","err");return false}
  try{await write(fn);if(okMsg)toast(okMsg,"ok");return true}
  catch(e){if(e.code==="denied")e=new AppError("Not allowed. Your login must be an admin (your UID has to be listed under “admins” in the database).","denied");reportError(e);return false}
}
function audit(action,details){if(!isAdmin)return;try{db.ref("audit").push({at:SERVER_TS,action,by:adminUser.email||adminUser.uid,details:JSON.stringify(details||{}).slice(0,400)})}catch(e){}}

/* ---------- live data ---------- */
function listen(path){
  db.ref(path).on("value",snap=>{
    raw[path]=snap.val();loaded[path]=true;
    if(Object.values(loaded).every(Boolean)){
      if(!raw.settings||!raw.members||!raw.tasks){showBanner("<strong>The database is empty.</strong> Import <code>starter-data.json</code> in the Firebase console (README, step 3).");return}
      derive();S.ready=true;hideBanner();
      if(me!==""&&!member(me)){me="";lsSet(ME_KEY,"")}
      renderAll();maybeRoll();
    }
  },err=>showBanner("<strong>Can’t read the database.</strong> "+esc(err.message||"")+" Check the rules (README, step 3)."));
}
["settings","members","tasks","completions"].forEach(listen);
db.ref(".info/connected").on("value",s=>{connected=!!s.val();const el=$("conn");el.className="conn "+(connected?"live":"off");el.textContent=connected?"● Live":"● Offline"});

function maybeRoll(){
  const s=S.settings;if(!s||!s.autoReset||!connected)return;
  const target=weekTarget(s.resetWeekday);
  if(target>s.weekStart){
    const n=s.weekNo+1;
    db.ref().update({"settings/weekNo":n,"settings/weekId":"w"+n,"settings/weekStart":target}).catch(()=>{});
  }
}
setInterval(maybeRoll,60000);

/* ---------- render main ---------- */
function renderAll(){renderMe();renderProgress();renderPeople();renderTab();if($("drawer").classList.contains("open")&&isAdmin&&(adminTab==="summary"||adminTab==="records"))renderAdmin()}
function renderMe(){$("meSelect").innerHTML='<option value="">Choose your name…</option>'+S.members.map(m=>'<option value="'+m.id+'"'+(me===m.id?" selected":"")+'>'+esc(m.name)+'</option>').join("")}
function renderProgress(){
  $("weekLabel").textContent="Week of "+fmtDate(S.settings.weekStart);
  const reg=regularTasks(),total=reg.length,done=reg.filter(t=>countFor(t.id)>=t.max).length;
  $("progressText").textContent=done+" of "+total+" household chores complete";
  $("progressBar").style.width=(total?done/total*100:0)+"%";
  const un=reg.filter(t=>!claimOf(t)&&countFor(t.id)<t.max).length,st=$("overallStatus");
  if(total&&done===total){st.className="status";st.textContent="All regular chores are done. Great work, everyone!"}
  else if(un>0){st.className="status warn";st.textContent=un+(un===1?" chore is":" chores are")+" still unclaimed. Open “My chores” to pick some up."}
  else{st.className="status warn";st.textContent=(total-done)+(total-done===1?" chore":" chores")+" left to finish."}
  if(me!==""){const mine=reg.filter(t=>claimOf(t)===me);$("myProgress").textContent="You: "+mine.filter(t=>countFor(t.id)>=t.max).length+"/"+mine.length+" done";$("myProgress").hidden=false}else $("myProgress").hidden=true;
}
function renderPeople(){
  const T=totals();
  $("people").innerHTML=S.members.map((m,i)=>'<button type="button" class="person'+(me===m.id?" active":"")+'" data-pick="'+m.id+'"><h3>'+esc(m.name)+'</h3><div class="points">'+T[i].points+' pts</div><div class="meta">'+T[i].regDone+'/'+T[i].assigned+' chores done</div><div class="money">'+moneyC(T[i].weekEarn)+' this week</div><div class="meta">'+moneyC(T[i].allEarn)+' total paid</div></button>').join("");
}
function taskCard(t){
  const paid=t.kind==="paid",owner=claimOf(t),mine=me!==""&&owner===me,cnt=countFor(t.id),done=cnt>=t.max,isBusy=busy.has(t.id);
  const whoPill=!owner?'<span class="pill none">Unclaimed</span>':'<span class="pill who">'+(mine?"You":esc(mname(owner)))+'</span>';
  const pts=(paid&&S.settings.paidPointMode==="zero")?"":'<span class="pill">'+t.points+(t.points===1?" pt":" pts")+'</span>';
  const kind=paid?'<span class="pill pay">Paid · '+moneyC(rate())+'/hr</span>':'<span class="pill">Required</span>';
  const count=t.max>1?'<span class="pill">'+cnt+'/'+t.max+' done</span>':"";
  const earned=paid?weekComps().filter(c=>c.task===t.id).reduce((a,c)=>a+c.paymentCents,0):0;
  const earnPill=earned>0?'<span class="pill done">Earned '+moneyC(earned)+'</span>':"";
  let lead,acts="";
  if(!paid&&t.max===1)lead='<input type="checkbox" data-done="'+t.id+'" aria-label="Mark '+esc(t.name)+' complete"'+(done?" checked":"")+((mine&&!isBusy)?"":" disabled")+'>';
  else lead='<span style="width:24px;display:inline-block;text-align:center">'+(done?"✔":"")+'</span>';
  const dis=isBusy?" disabled":"";
  if(!owner&&!done)acts+='<button type="button" class="small" data-claim="'+t.id+'"'+dis+'>Claim</button>';
  if(mine&&!done&&(paid||t.max>1))acts+='<button type="button" class="small good" data-complete="'+t.id+'"'+dis+'>'+(paid?"Complete…":"Mark done")+'</button>';
  if(mine&&cnt===0)acts+='<button type="button" class="small secondary" data-release="'+t.id+'"'+dis+'>Give up</button>';
  if(mine&&!paid&&t.max>1&&cnt>0)acts+='<button type="button" class="small secondary" data-undo="'+t.id+'"'+dis+'>Undo last</button>';
  return '<article class="task'+(done?" completed":"")+'">'+lead+'<div><div class="task-name">'+esc(t.name)+'</div><div class="task-desc">'+esc(t.desc||"")+'</div><div class="task-meta">'+whoPill+kind+pts+count+earnPill+'</div></div><div class="acts">'+acts+'</div></article>';
}
const list=a=>a.length?'<div class="task-list">'+a.map(taskCard).join("")+'</div>':"";
function renderTab(){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  const reg=regularTasks(),paid=S.tasks.filter(t=>t.active&&t.kind==="paid");let h="";
  if(tab==="mine"){
    if(me==="")h='<div class="empty">Pick your name in the “I am” box at the top to see and complete your chores.</div>';
    else{
      const mine=reg.filter(t=>claimOf(t)===me),open=reg.filter(t=>!claimOf(t)&&countFor(t.id)<t.max);
      h+='<div class="section-title">Your chores ('+mine.length+')</div>'+(mine.length?list(mine):'<div class="empty">You have no chores yet. Claim some below.</div>');
      h+='<div class="section-title">Available to claim ('+open.length+')</div>'+(open.length?'<p class="hint">Tap Claim to take a chore. Every chore needs an owner by the end of the week.</p>'+list(open):'<div class="empty">Every chore has been claimed.</div>');
      const myPaid=paid.filter(t=>claimOf(t)===me);if(myPaid.length)h+='<div class="section-title">Your paid jobs</div>'+list(myPaid);
    }
  }else if(tab==="all"){
    h+='<p class="hint">Everyone’s chores at a glance. You can only complete your own.</p>';
    S.members.forEach(m=>{const L=reg.filter(t=>claimOf(t)===m.id);if(L.length)h+='<div class="section-title">'+esc(m.name)+' ('+L.filter(t=>countFor(t.id)>=t.max).length+'/'+L.length+')</div>'+list(L)});
    const un=reg.filter(t=>!claimOf(t));if(un.length)h+='<div class="section-title">Unclaimed ('+un.length+')</div>'+list(un);
  }else{
    h+='<p class="hint">Optional extra jobs. Pay = time worked × hourly rate (currently <strong>'+moneyC(rate())+'/hour</strong>). Claim a job, do it, then tap Complete… and enter your time.</p>'+(paid.length?list(paid):'<div class="empty">No paid jobs right now.</div>')+earningsHTML();
  }
  $("tabContent").innerHTML=h;
}
function earningsHTML(){
  const T=totals();
  let h='<div class="row" style="justify-content:space-between;margin-top:16px"><div class="section-title" style="margin:0">Paid-task earnings breakdown</div><button type="button" class="secondary small" id="dlPaid">⬇ Download Excel</button></div><div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Member</th><th class="num">Jobs (week)</th><th class="num">Time (week)</th><th class="num">Earned (week)</th><th class="num">Jobs (all)</th><th class="num">Time (all)</th><th class="num">Earned (all)</th></tr></thead><tbody>';
  T.forEach(t=>{h+='<tr><td>'+esc(mname(t.id))+'</td><td class="num">'+t.weekJobs+'</td><td class="num">'+fmtMin(t.weekMin)+'</td><td class="num">'+moneyC(t.weekEarn)+'</td><td class="num">'+t.allJobs+'</td><td class="num">'+fmtMin(t.allMin)+'</td><td class="num"><strong>'+moneyC(t.allEarn)+'</strong></td></tr>'});
  h+='</tbody></table></div>';
  const opts='<option value="all">Everyone</option>'+S.members.map(m=>'<option value="'+m.id+'"'+(histFilter===m.id?" selected":"")+'>'+esc(m.name)+'</option>').join("");
  h+='<div class="row" style="margin-top:16px;justify-content:space-between"><div class="section-title" style="margin:0">Paid-task history</div><select id="histFilter" style="width:auto">'+opts+'</select></div>';
  const rows=S.comps.filter(c=>c.kind==="paid"&&!c.voided&&(histFilter==="all"||c.member===histFilter)).slice(0,60);
  h+=rows.length?'<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Date</th><th>Who</th><th>Task</th><th class="num">Time</th><th class="num">Rate used</th><th class="num">Paid</th></tr></thead><tbody>'+rows.map(c=>'<tr><td>'+fmtDT(c.at)+'</td><td>'+esc(who(c))+'</td><td>'+esc(c.taskName)+'</td><td class="num">'+fmtMin(c.minutes)+'</td><td class="num">'+moneyC(c.rateCents)+'/hr</td><td class="num"><strong>'+moneyC(c.paymentCents)+'</strong></td></tr>').join("")+'</tbody></table></div>':'<div class="empty" style="margin-top:8px">No paid jobs completed yet.</div>';
  return h;
}

/* ---------- member actions ---------- */
async function guarded(key,fn){
  if(busy.has(key))return;busy.add(key);renderTab();
  try{await fn()}catch(e){reportError(e)}finally{busy.delete(key);renderTab()}
}
function needMe(){if(me===""){toast("Choose your name first.","err");return false}return true}
function freeSlot(task){for(let i=1;i<=task.max;i++){if(!compKeys.has(S.settings.weekId+"_"+task.id+"_s"+i))return i}return 0}
function buildRecord(task,minutes){
  const s=S.settings,m=member(me),slot=freeSlot(task);
  if(!slot)throw new AppError("All completion slots for this task are used this week. Ask the admin to void a record or raise the limit.","full");
  const rec={member:m.id,memberName:m.name,task:task.id,taskName:task.name,kind:task.kind,week:s.weekId,weekStart:s.weekStart,slot:"s"+slot,
    points:(task.kind==="paid"&&s.paidPointMode==="zero")?0:task.points,at:SERVER_TS};
  if(task.kind==="paid"){rec.minutes=minutes;rec.rateCents=s.rateCents;rec.paymentCents=payFor(minutes,s.rateCents)}
  return{key:s.weekId+"_"+task.id+"_s"+slot,rec};
}
async function saveCompletion(task,minutes){
  const {key,rec}=buildRecord(task,minutes);
  await write(()=>db.ref("completions/"+key).set(rec));      // create-only: a duplicate is rejected by the rules
  return rec;
}
document.addEventListener("click",e=>{
  const t=e.target.closest("[data-claim],[data-release],[data-complete],[data-undo],[data-pick],.tab,#dlPaid");if(!t)return;
  const d=t.dataset;
  if(t.id==="dlPaid"){downloadExcel(false);return}
  if(d.claim){if(!needMe())return;guarded(d.claim,async()=>{await write(()=>db.ref("tasks/"+d.claim+"/claim").set({member:me,week:S.settings.weekId}));toast("Claimed — saved","ok")})}
  else if(d.release)guarded(d.release,async()=>{await write(()=>db.ref("tasks/"+d.release+"/claim").remove());toast("Released — saved","ok")});
  else if(d.undo)guarded(d.undo,undoLatest(d.undo));
  else if(d.complete){const task=S.tasks.find(x=>x.id===d.complete);if(task.kind==="paid")openPayModal(task);else completeRegular(task)}
  else if(d.pick!==undefined){me=d.pick;lsSet(ME_KEY,me);renderAll()}
  else if(t.classList.contains("tab")){tab=t.dataset.tab;renderTab()}
});
const undoLatest=id=>async()=>{const c=latestMine(id);if(!c)return;if(c.kind!=="regular")throw new AppError("Paid completions can only be changed by the admin.","x");await write(()=>db.ref("completions/"+c.key).remove());toast("Undone — saved","ok")};
document.addEventListener("change",e=>{
  const el=e.target;
  if(el.id==="meSelect"){me=el.value;lsSet(ME_KEY,me);renderAll()}
  else if(el.id==="histFilter"){histFilter=el.value;renderTab()}
  else if(el.dataset&&el.dataset.done){
    const task=S.tasks.find(x=>x.id===el.dataset.done);
    if(el.checked)completeRegular(task);else guarded(task.id,undoLatest(task.id));
    renderTab();
  }
});
function completeRegular(task){
  if(!needMe())return;
  guarded(task.id,async()=>{const r=await saveCompletion(task,null);toast("Saved ✔ +"+r.points+" pts for “"+task.name+"”","ok")});
}

/* ---------- paid completion modal ---------- */
let modalClose=null;
function openModal(html,onCancel){$("modal").innerHTML=html;$("modalWrap").hidden=false;modalClose=onCancel||null}
function closeModal(ok){$("modalWrap").hidden=true;$("modal").innerHTML="";const f=modalClose;modalClose=null;if(!ok&&f)f()}
$("modalWrap").addEventListener("mousedown",e=>{if(e.target.id==="modalWrap")closeModal()});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(!$("modalWrap").hidden)closeModal();else if($("drawer").classList.contains("open"))closeMenu()}});

function openPayModal(task){
  if(!needMe())return;
  const rc=rate();
  openModal('<h3>Complete: '+esc(task.name)+'</h3><p class="hint">How long did it take? Pay = time worked × '+moneyC(rc)+' per hour.</p>'+
    '<div class="grid2"><div class="field"><label for="payH">Hours</label><input type="number" id="payH" min="0" max="12" step="1" value="0" inputmode="numeric"></div><div class="field"><label for="payM">Minutes</label><input type="number" id="payM" min="0" max="59" step="1" value="0" inputmode="numeric"></div></div>'+
    '<div class="quick"><button type="button" class="secondary small" data-q="15">15 min</button><button type="button" class="secondary small" data-q="30">30 min</button><button type="button" class="secondary small" data-q="45">45 min</button><button type="button" class="secondary small" data-q="60">1 hr</button><button type="button" class="secondary small" data-q="120">2 hr</button></div>'+
    '<div class="paybox"><div id="payTime">Time worked: 0m</div><div class="big" id="payAmt">'+moneyC(0)+'</div><div class="lbl" id="payNote"></div></div>'+
    '<div class="row"><button type="button" class="good" id="payOk" disabled>Confirm &amp; save</button><button type="button" class="secondary" id="payNo">Cancel</button></div><div id="payErr" class="status" style="background:#feecee;color:#922b3a;margin-top:10px" hidden></div>');
  const H=$("payH"),M=$("payM"),ok=$("payOk");let sending=false;
  const mins=()=>Math.max(0,Math.floor(Number(H.value)||0))*60+Math.max(0,Math.floor(Number(M.value)||0));
  const upd=()=>{const m=mins(),valid=m>=1&&m<=720&&Number(M.value)<60&&Number(H.value)>=0&&Number(M.value)>=0;
    $("payTime").textContent="Time worked: "+fmtMin(m);$("payAmt").textContent=moneyC(payFor(m,rc));
    $("payNote").textContent=valid?"Rate: "+moneyC(rc)+"/hr. Saved only after the database confirms.":(m>720?"Maximum is 12 hours per entry.":"Enter at least 1 minute (minutes: 0–59).");
    ok.disabled=!valid||sending};
  H.oninput=M.oninput=upd;
  document.querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{const q=+b.dataset.q;H.value=Math.floor(q/60);M.value=q%60;upd()});
  $("payNo").onclick=()=>closeModal();
  ok.onclick=async()=>{
    const m=mins();sending=true;ok.disabled=true;ok.textContent="Saving…";$("payErr").hidden=true;
    try{
      if(S.settings.rateCents!==rc)throw new AppError("The hourly rate just changed. Please close and reopen this window.","rate");
      const r=await saveCompletion(task,m);
      closeModal(true);toast("Saved ✔ "+fmtMin(r.minutes)+" × "+moneyC(r.rateCents)+"/hr = "+moneyC(r.paymentCents),"ok");
    }catch(e){$("payErr").hidden=false;$("payErr").textContent=e.message+(e.code==="timeout"?" Do not tap again until you have checked the history table.":"");sending=false;ok.textContent="Confirm & save";upd()}
  };
  upd();H.focus();
}

/* ---------- ADMIN ---------- */
auth.onAuthStateChanged(async user=>{
  adminUser=user;isAdmin=false;
  if(user){try{const s=await db.ref("admins/"+user.uid).once("value");isAdmin=s.val()===true}catch(e){}}
  $("logoutBtn").hidden=!user;
  if($("drawer").classList.contains("open"))renderAdmin();
});
function openMenu(){$("drawer").classList.add("open");$("overlay").classList.add("open");renderAdmin()}
function closeMenu(){$("drawer").classList.remove("open");$("overlay").classList.remove("open")}
$("menuBtn").addEventListener("click",openMenu);$("closeMenu").addEventListener("click",closeMenu);$("overlay").addEventListener("click",closeMenu);
$("logoutBtn").addEventListener("click",async()=>{await auth.signOut();toast("Logged out of admin","ok")});

function renderAdmin(){
  const body=$("drawerBody");
  if(!adminUser){
    body.innerHTML='<div class="card"><h3 style="margin-top:0">Admin login</h3><p class="hint">Only for the person managing the chart. Login is checked by Firebase Authentication, not by this page.</p><form id="loginForm"><div class="field"><label for="admEmail">Admin email</label><input type="email" id="admEmail" autocomplete="username" required></div><div class="field"><label for="admPw">Password</label><input type="password" id="admPw" autocomplete="current-password" required></div><button type="submit" id="admLoginBtn">Log in</button><div id="loginErr" class="status warn" style="margin-top:10px" hidden></div></form></div>';
    $("loginForm").onsubmit=async ev=>{ev.preventDefault();const b=$("admLoginBtn");b.disabled=true;b.textContent="Checking…";$("loginErr").hidden=true;
      try{await auth.signInWithEmailAndPassword($("admEmail").value.trim(),$("admPw").value);toast("Logged in","ok")}
      catch(e){$("loginErr").hidden=false;$("loginErr").textContent=/too-many/.test(e.code||"")?"Too many attempts. Try again later.":/network/.test(e.code||"")?"Can’t reach the server.":"Incorrect email or password.";b.disabled=false;b.textContent="Log in"}};
    return;
  }
  if(!isAdmin){body.innerHTML='<div class="card"><h3 style="margin-top:0">Logged in, but not an admin</h3><p class="hint">Signed in as '+esc(adminUser.email||adminUser.uid)+'. In the Firebase console, add <code>admins / '+esc(adminUser.uid)+' = true</code> (README step 5), then log out and back in.</p></div>';return}
  if(!S.ready){body.innerHTML='<div class="empty">Loading…</div>';return}
  const tabs=[["summary","Summary"],["settings","Settings"],["people","People"],["chores","Chores"],["records","Records"],["audit","Audit log"],["security","Security"]];
  body.innerHTML='<div class="atabs">'+tabs.map(t=>'<button type="button" class="atab'+(adminTab===t[0]?" active":"")+'" data-atab="'+t[0]+'">'+t[1]+'</button>').join("")+'</div><div id="adminPane"></div>';
  ({summary:adminSummary,settings:adminSettings,people:adminPeople,chores:adminChores,records:adminRecords,audit:adminAudit,security:adminSecurity})[adminTab]($("adminPane"));
}
$("drawerBody").addEventListener("click",e=>{const b=e.target.closest("[data-atab]");if(b){adminTab=b.dataset.atab;renderAdmin()}});

/* ----- Excel / JSON export ----- */
function download(blobParts,name,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(blobParts,{type}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function stamp(){return isoDate(new Date())}
function downloadBackup(){
  const data={app:"chore-chart",version:1,exportedAt:new Date().toISOString(),settings:raw.settings,members:raw.members,tasks:raw.tasks,completions:raw.completions||{}};
  download([JSON.stringify(data,null,2)],"chore-backup-"+stamp()+".json","application/json");lsSet(BACKUP_KEY,String(Date.now()));return data;
}
function downloadExcel(full){
  if(!window.XLSX){toast("The Excel library didn’t load. Check your internet connection.","err");return}
  const T=totals(),wb=XLSX.utils.book_new(),H=h=>({wch:h});
  const add=(name,rows,widths)=>{const ws=XLSX.utils.aoa_to_sheet(rows);ws["!cols"]=widths.map(H);XLSX.utils.book_append_sheet(wb,ws,name)};
  const c2=c=>(Number(c)||0)/100;
  if(full)add("Summary",[["Member","Points (this week)","Chores done","Chores assigned","Paid jobs (week)","Paid hours (week)","Earned (week)","Paid jobs (all)","Paid hours (all)","Earned (all)"]].concat(T.map(t=>[mname(t.id),t.points,t.regDone,t.assigned,t.weekJobs,+(t.weekMin/60).toFixed(2),c2(t.weekEarn),t.allJobs,+(t.allMin/60).toFixed(2),c2(t.allEarn)])),[16,16,12,14,14,14,13,13,13,13]);
  add("Paid earnings",[["Member","Jobs (week)","Hours (week)","Earned (week)","Jobs (all time)","Hours (all time)","Earned (all time)"]].concat(T.map(t=>[mname(t.id),t.weekJobs,+(t.weekMin/60).toFixed(2),c2(t.weekEarn),t.allJobs,+(t.allMin/60).toFixed(2),c2(t.allEarn)])),[16,12,13,13,15,16,16]);
  const paidRows=S.comps.filter(c=>c.kind==="paid").map(c=>[new Date(c.at).toLocaleString(),who(c),c.taskName,c.minutes,+(c.minutes/60).toFixed(2),c2(c.rateCents),c2(c.paymentCents),c.voided?"Voided":"Active",c.voidReason||""]);
  add("Paid history",[["Completed","Member","Task","Minutes","Hours","Hourly rate","Payment","Status","Void reason"]].concat(paidRows),[20,16,28,9,8,11,10,9,24]);
  if(full){
    add("All records",[["Completed","Week start","Member","Task","Type","Points","Minutes","Hourly rate","Payment","Status","Void reason"]].concat(S.comps.map(c=>[new Date(c.at).toLocaleString(),c.weekStart,who(c),c.taskName,c.kind,c.points,c.minutes==null?"":c.minutes,c.rateCents==null?"":c2(c.rateCents),c.paymentCents==null?"":c2(c.paymentCents),c.voided?"Voided":"Active",c.voidReason||""])),[20,12,16,28,9,7,9,11,10,9,24]);
    add("Chores",[["Name","Type","Points","Max per week","Active","Claimed by (this week)","Description"]].concat(S.tasks.map(t=>[t.name,t.kind,t.points,t.max,t.active?"Yes":"No",claimOf(t)?mname(claimOf(t)):"",t.desc||""])),[34,9,8,12,8,20,50]);
  }
  XLSX.writeFile(wb,(full?"chore-chart-":"paid-earnings-")+stamp()+".xlsx");
}

/* ----- Summary ----- */
function adminSummary(p){
  const T=totals(),reg=regularTasks(),done=reg.filter(t=>countFor(t.id)>=t.max).length;
  const weekPay=T.reduce((a,t)=>a+t.weekEarn,0),allPay=T.reduce((a,t)=>a+t.allEarn,0),weekMin=T.reduce((a,t)=>a+t.weekMin,0);
  const last=Number(lsGet(BACKUP_KEY))||0,days=last?Math.floor((Date.now()-last)/864e5):null;
  const stale=days===null||days>=7;
  p.innerHTML=(stale?'<div class="status warn" style="margin-bottom:10px">'+(days===null?"No backup downloaded from this device yet.":"Last backup on this device was "+days+" days ago.")+' Download one below.</div>':'<div class="status" style="margin-bottom:10px">Last backup on this device: '+(days===0?"today":days+" day(s) ago")+'.</div>')+
   '<div class="stat-grid"><div class="stat"><div class="l">Chores done this week</div><div class="v">'+done+' / '+reg.length+'</div></div><div class="stat"><div class="l">Paid this week</div><div class="v">'+moneyC(weekPay)+'</div></div><div class="stat"><div class="l">Paid all-time</div><div class="v">'+moneyC(allPay)+'</div></div><div class="stat"><div class="l">Paid time this week</div><div class="v">'+fmtMin(weekMin)+'</div></div><div class="stat"><div class="l">Hourly rate</div><div class="v">'+moneyC(rate())+'</div></div><div class="stat"><div class="l">Week started</div><div class="v" style="font-size:1rem">'+fmtDate(S.settings.weekStart)+'</div></div></div>'+
   '<div class="tablewrap"><table><thead><tr><th>Member</th><th class="num">Points</th><th class="num">Chores</th><th class="num">Paid jobs (wk)</th><th class="num">Paid (wk)</th><th class="num">Paid (all)</th></tr></thead><tbody>'+T.map(t=>'<tr><td>'+esc(mname(t.id))+'</td><td class="num">'+t.points+'</td><td class="num">'+t.regDone+'/'+t.assigned+'</td><td class="num">'+t.weekJobs+'</td><td class="num">'+moneyC(t.weekEarn)+'</td><td class="num">'+moneyC(t.allEarn)+'</td></tr>').join("")+'</tbody></table></div>'+
   '<div class="section-title">Backup &amp; export</div><div class="row"><button type="button" id="dlXlsx">⬇ Excel (.xlsx)</button><button type="button" class="secondary" id="dlJson">⬇ Backup (.json)</button><button type="button" class="secondary" id="upJson">⬆ Restore backup…</button></div><p class="hint">The .json backup holds everything and can be restored; the Excel file is for reading, sharing and printing.</p>'+
   '<div class="section-title">Weekly actions</div><div class="row"><button type="button" id="balBtn">Balance assignments</button><button type="button" class="danger" id="newWeek">Start new week now</button></div><p class="hint">Starting a new week clears everyone’s claims and weekly points. All records and earnings are kept.</p>';
  $("dlXlsx").onclick=()=>downloadExcel(true);
  $("dlJson").onclick=()=>{downloadBackup();toast("Backup downloaded","ok");adminSummary($("adminPane"))};
  $("upJson").onclick=()=>$("restoreFile").click();
  $("balBtn").onclick=async()=>{if(!confirm("Assign all unclaimed chores fairly based on each person’s target?"))return;
    const full=confirm("Also re-balance chores that are already assigned (only ones with no completion yet this week)?\n\nOK = re-balance everything not yet done.  Cancel = only assign unclaimed chores.");
    if(await adminWrite(()=>db.ref().update(balanceUpdates(full)),"Assignments balanced ✔"))audit("balance",{full})};
  $("newWeek").onclick=async()=>{if(!confirm("Start a new week now? Claims are cleared and weekly points reset. Records and earnings are kept."))return;
    const n=S.settings.weekNo+1;if(await adminWrite(()=>db.ref().update({"settings/weekNo":n,"settings/weekId":"w"+n,"settings/weekStart":isoDate(new Date())}),"New week started ✔"))audit("new_week",{n})};
}
function balanceUpdates(rebalance){
  const wid=S.settings.weekId,cnt={},reg=regularTasks();S.members.forEach(m=>cnt[m.id]=0);
  const locked=t=>S.comps.some(c=>c.task===t.id&&c.week===wid);
  reg.forEach(t=>{const o=claimOf(t);if(o&&(!rebalance||locked(t)))cnt[o]++});
  const todo=reg.filter(t=>!claimOf(t)||(rebalance&&!locked(t))).sort((a,b)=>b.points-a.points||a.order-b.order),up={};
  todo.forEach(t=>{let best=null,bk=null;S.members.forEach(m=>{const q=m.quota,k=[cnt[m.id]>=q?1:0,cnt[m.id]/Math.max(q,1),cnt[m.id]];
    if(!bk||k[0]<bk[0]||(k[0]===bk[0]&&(k[1]<bk[1]||(k[1]===bk[1]&&k[2]<bk[2])))){best=m.id;bk=k}});
    up["tasks/"+t.id+"/claim"]={member:best,week:wid};cnt[best]++});
  return up;
}
$("restoreFile").addEventListener("change",e=>{
  const f=e.target.files[0];e.target.value="";if(!f)return;const r=new FileReader();
  r.onload=async()=>{
    let d;try{d=JSON.parse(r.result)}catch(_){toast("That file isn’t valid JSON.","err");return}
    if(!d||d.app!=="chore-chart"||!d.settings||!d.members||!d.tasks){toast("That doesn’t look like a chore-chart backup.","err");return}
    if(!confirm("Replace ALL current data with this backup ("+Object.keys(d.completions||{}).length+" records)?\n\nA safety backup of the current data will be downloaded first."))return;
    downloadBackup();
    if(await adminWrite(()=>db.ref().update({settings:d.settings,members:d.members,tasks:d.tasks,completions:d.completions||null}),"Backup restored ✔"))audit("restore",{file:f.name});
  };r.readAsText(f);
});

/* ----- Settings ----- */
function adminSettings(p){
  const s=S.settings;
  p.innerHTML='<form class="card" id="setForm"><div class="grid2">'+
   '<div class="field"><label>Hourly rate for paid tasks ('+esc(s.currency)+' per hour)</label><input type="number" name="rate" min="0.01" max="1000" step="0.01" required value="'+(s.rateCents/100).toFixed(2)+'"></div>'+
   '<div class="field"><label>Currency symbol</label><input type="text" name="currency" maxlength="4" required value="'+esc(s.currency)+'"></div>'+
   '<div class="field"><label>Starting points per person each week</label><input type="number" name="startPoints" min="-1000" max="1000" step="1" required value="'+s.startPoints+'"></div>'+
   '<div class="field"><label>Default chores per person (target)</label><input type="number" name="defaultQuota" min="0" max="50" step="1" required value="'+s.defaultQuota+'"></div>'+
   '<div class="field"><label>Paid-task points</label><select name="paidPointMode"><option value="points"'+(s.paidPointMode==="points"?" selected":"")+'>Use each paid task’s point value</option><option value="zero"'+(s.paidPointMode==="zero"?" selected":"")+'>No points (payment only)</option></select></div>'+
   '<div class="field"><label>Week starts on</label><select name="resetWeekday">'+["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((d,i)=>'<option value="'+(i+1)+'"'+(s.resetWeekday===i+1?" selected":"")+'>'+d+'</option>').join("")+'</select></div>'+
   '<div class="field full"><label class="check"><input type="checkbox" name="autoReset"'+(s.autoReset?" checked":"")+'> Start a new week automatically (the first device that opens the page on/after that day does it)</label></div></div>'+
   '<p class="hint">A new hourly rate applies only to <strong>future</strong> paid completions. Records already saved keep the rate they were saved with. Changing the default target resets every member’s target.</p><button type="submit">Save settings</button></form>';
  $("setForm").onsubmit=async ev=>{ev.preventDefault();const f=ev.target.elements;
    const rc=Math.round(Number(f.rate.value)*100);
    if(rc!==s.rateCents&&!confirm("Change the hourly rate from "+moneyC(s.rateCents)+" to "+moneyC(rc)+"? This only affects future paid tasks."))return;
    const up={"settings/rateCents":rc,"settings/currency":f.currency.value.trim()||"$","settings/startPoints":Number(f.startPoints.value),"settings/defaultQuota":Number(f.defaultQuota.value),"settings/paidPointMode":f.paidPointMode.value,"settings/resetWeekday":Number(f.resetWeekday.value),"settings/autoReset":f.autoReset.checked};
    if(Number(f.defaultQuota.value)!==s.defaultQuota)S.members.forEach(m=>up["members/"+m.id+"/quota"]=Number(f.defaultQuota.value));
    if(await adminWrite(()=>db.ref().update(up),"Settings saved ✔")){audit("settings",up);adminSettings($("adminPane"))}};
}

/* ----- People ----- */
function adminPeople(p){
  p.innerHTML='<p class="hint">Names show everywhere (old records keep the name they were saved with).</p>'+S.members.map(m=>'<form class="card admin-card" data-member="'+m.id+'"><div class="grid2"><div class="field"><label>Member '+m.id.slice(1)+' name</label><input type="text" name="name" maxlength="40" required value="'+esc(m.name)+'"></div><div class="field"><label>Chore target</label><input type="number" name="quota" min="0" max="50" value="'+m.quota+'"></div></div><button type="submit" class="small">Save</button></form>').join("");
  p.onsubmit=async ev=>{const f=ev.target;if(!f.dataset.member)return;ev.preventDefault();const id=f.dataset.member,e2=f.elements;
    if(await adminWrite(()=>db.ref("members/"+id).set({name:e2.name.value.trim(),quota:Number(e2.quota.value)}),"Saved ✔")){audit("member",{id,name:e2.name.value});}};
}

/* ----- Chores ----- */
const slotsFor=n=>{const o={};for(let i=1;i<=n;i++)o["s"+i]=true;return o};
function taskForm(t){
  const n=!t;t=t||{id:"",name:"",desc:"",kind:"regular",points:2,max:1,active:true};
  return '<form class="card admin-card" data-task="'+t.id+'"><div class="grid2"><div class="field full"><label>'+(n?"New chore name":"Name")+'</label><input type="text" name="name" maxlength="80" required value="'+esc(t.name)+'"></div>'+
   '<div class="field full"><label>Description</label><input type="text" name="desc" maxlength="300" value="'+esc(t.desc||"")+'"></div>'+
   '<div class="field"><label>Type</label><select name="kind"><option value="regular"'+(t.kind==="regular"?" selected":"")+'>Regular (required, unpaid)</option><option value="paid"'+(t.kind==="paid"?" selected":"")+'>Paid (optional, hourly)</option></select></div>'+
   '<div class="field"><label>Points</label><input type="number" name="points" min="0" max="100" step="1" value="'+t.points+'"></div>'+
   '<div class="field"><label>Max completions per week</label><input type="number" name="max" min="1" max="20" step="1" value="'+t.max+'"></div>'+
   (n?'':'<div class="field"><label>Assigned to (this week)</label><select name="assigned"><option value="">Unassigned</option>'+S.members.map(m=>'<option value="'+m.id+'"'+(claimOf(t)===m.id?" selected":"")+'>'+esc(m.name)+'</option>').join("")+'</select></div>')+
   '<div class="field"><label class="check"><input type="checkbox" name="active"'+(t.active?" checked":"")+'> Active (visible to everyone)</label></div></div>'+
   '<div class="row"><button type="submit" class="small">'+(n?"Add chore":"Save")+'</button>'+(n?"":'<button type="button" class="small danger" data-deltask="'+t.id+'">Delete</button>')+'</div></form>';
}
function adminChores(p){
  p.innerHTML='<div class="section-title" style="margin-top:0">Add a chore</div>'+taskForm(null)+'<div class="section-title">Existing chores ('+S.tasks.length+')</div><p class="hint">Deleting a chore never deletes past records — they keep their own copy of the name, points and pay.</p>'+S.tasks.map(taskForm).join("");
  p.onsubmit=async ev=>{const f=ev.target;if(f.dataset.task===undefined)return;ev.preventDefault();const e2=f.elements;
    const id=f.dataset.task||db.ref("tasks").push().key,old=S.tasks.find(x=>x.id===id),max=Number(e2.max.value);
    const rec={name:e2.name.value.trim(),desc:e2.desc.value.trim(),kind:e2.kind.value,points:Number(e2.points.value),max,active:e2.active.checked,order:old?old.order:(S.tasks.reduce((a,t)=>Math.max(a,t.order||0),0)+1),slots:slotsFor(max)};
    if(old&&claimOf(old))rec.claim=old.claim;
    if(old&&e2.assigned){const v=e2.assigned.value;if(v===""){delete rec.claim}else if(claimOf(old)!==v){rec.claim={member:v,week:S.settings.weekId}}}
    if(await adminWrite(()=>db.ref("tasks/"+id).set(rec),"Saved ✔")){audit("task",{id,name:rec.name});adminChores($("adminPane"))}};
  p.onclick=async ev=>{const b=ev.target.closest("[data-deltask]");if(!b)return;const t=S.tasks.find(x=>x.id===b.dataset.deltask);
    if(!confirm("Delete “"+t.name+"”? Past records are kept. To hide it temporarily, untick Active instead."))return;
    if(await adminWrite(()=>db.ref("tasks/"+t.id).remove(),"Deleted")){audit("delete_task",{id:t.id,name:t.name});adminChores($("adminPane"))}};
}

/* ----- Records ----- */
function adminRecords(p){
  const f=recFilter;
  const rows=S.comps.filter(c=>(f.scope==="all"||c.week===S.settings.weekId)&&(!f.member||c.member===f.member)&&(!f.kind||c.kind===f.kind)),shown=rows.slice(0,200);
  p.innerHTML='<div class="grid3"><div class="field"><label>Show</label><select id="rfScope"><option value="week"'+(f.scope==="week"?" selected":"")+'>This week</option><option value="all"'+(f.scope==="all"?" selected":"")+'>All time</option></select></div>'+
   '<div class="field"><label>Member</label><select id="rfMember"><option value="">Everyone</option>'+S.members.map(m=>'<option value="'+m.id+'"'+(m.id===f.member?" selected":"")+'>'+esc(m.name)+'</option>').join("")+'</select></div>'+
   '<div class="field"><label>Type</label><select id="rfKind"><option value="">All</option><option value="regular"'+(f.kind==="regular"?" selected":"")+'>Regular</option><option value="paid"'+(f.kind==="paid"?" selected":"")+'>Paid</option></select></div></div>'+
   '<p class="hint">'+rows.length+' record'+(rows.length===1?"":"s")+(rows.length>200?" (newest 200 shown)":"")+'. Voiding keeps the record (struck through) and can be reversed. Deleting is permanent — download a backup first.</p>'+
   (shown.length?'<div class="tablewrap"><table><thead><tr><th>When</th><th>Member</th><th>Task</th><th class="num">Pts</th><th class="num">Time</th><th class="num">Rate</th><th class="num">Paid</th><th></th></tr></thead><tbody>'+shown.map(c=>'<tr class="'+(c.voided?"voided":"")+'"><td>'+fmtDT(c.at)+'</td><td>'+esc(who(c))+'</td><td>'+esc(c.taskName)+'</td><td class="num">'+c.points+'</td><td class="num">'+(c.minutes?fmtMin(c.minutes):"–")+'</td><td class="num">'+(c.rateCents!=null?moneyC(c.rateCents):"–")+'</td><td class="num">'+(c.paymentCents!=null?moneyC(c.paymentCents):"–")+'</td><td>'+
     (c.voided?'<button type="button" class="small secondary" data-restore="'+c.key+'">Restore</button>':'<button type="button" class="small secondary" data-edit="'+c.key+'">Edit</button> <button type="button" class="small secondary" data-void="'+c.key+'">Void</button>')+' <button type="button" class="small danger" data-del="'+c.key+'">Delete</button></td></tr>').join("")+'</tbody></table></div>':'<div class="empty">No records match.</div>');
  const re=()=>{recFilter={scope:$("rfScope").value,member:$("rfMember").value,kind:$("rfKind").value};adminRecords($("adminPane"))};
  ["rfScope","rfMember","rfKind"].forEach(id=>$(id).onchange=re);
  p.onclick=async ev=>{
    const b=ev.target.closest("[data-void],[data-restore],[data-edit],[data-del]");if(!b)return;const d=b.dataset;
    if(d.void){const why=prompt("Why are you voiding this record? (optional)");if(why===null)return;
      if(await adminWrite(()=>db.ref("completions/"+d.void).update({voided:true,voidReason:(why||"Voided by admin").slice(0,200)}),"Voided ✔"))audit("void",{key:d.void,why})}
    else if(d.restore){if(await adminWrite(()=>db.ref("completions/"+d.restore).update({voided:null,voidReason:null}),"Restored ✔"))audit("restore_record",{key:d.restore})}
    else if(d.del){if(!confirm("Permanently delete this record? This cannot be undone (a voided record is safer)."))return;
      if(await adminWrite(()=>db.ref("completions/"+d.del).remove(),"Deleted"))audit("delete_record",{key:d.del})}
    else if(d.edit)editRecord(S.comps.find(c=>c.key===d.edit));
  };
}
function editRecord(c){
  const paid=c.kind==="paid";
  openModal('<h3>Edit record</h3><p class="hint">'+esc(who(c))+' · '+esc(c.taskName)+' · '+fmtDT(c.at)+'</p><form id="recForm">'+
   (paid?'<div class="grid2"><div class="field"><label>Hours</label><input type="number" name="h" min="0" max="12" step="1" value="'+Math.floor(c.minutes/60)+'"></div><div class="field"><label>Minutes</label><input type="number" name="m" min="0" max="59" step="1" value="'+(c.minutes%60)+'"></div></div><div class="field"><label>Hourly rate used</label><input type="number" name="rate" min="0.01" max="1000" step="0.01" value="'+(c.rateCents/100).toFixed(2)+'"></div><div class="paybox"><div class="lbl">New payment</div><div class="big" id="recPay"></div></div>':"")+
   '<div class="field"><label>Points awarded</label><input type="number" name="points" min="-1000" max="1000" step="1" value="'+c.points+'"></div><div class="row"><button type="submit">Save correction</button><button type="button" class="secondary" id="recNo">Cancel</button></div></form>');
  const f=$("recForm"),e2=f.elements;
  const calc=()=>{const m=(Number(e2.h.value)||0)*60+(Number(e2.m.value)||0);return{m,rc:Math.round(Number(e2.rate.value)*100)}};
  const show=()=>{if(paid){const k=calc();$("recPay").textContent=moneyC(payFor(k.m,k.rc))}};
  if(paid){f.oninput=show;show()}
  $("recNo").onclick=()=>closeModal();
  f.onsubmit=async ev=>{ev.preventDefault();
    const up={points:Number(e2.points.value),edited:true};
    if(paid){const k=calc();if(k.m<1||k.m>720){toast("Time must be 1 minute to 12 hours.","err");return}up.minutes=k.m;up.rateCents=k.rc;up.paymentCents=payFor(k.m,k.rc)}
    if(!confirm("Save this correction? It is recorded in the audit log."))return;
    if(await adminWrite(()=>db.ref("completions/"+c.key).update(up),"Correction saved ✔")){audit("edit_record",{key:c.key,up});closeModal(true)}};
}

/* ----- Audit ----- */
async function adminAudit(p){
  p.innerHTML='<div class="empty">Loading…</div>';
  try{const snap=await db.ref("audit").orderByChild("at").limitToLast(100).once("value"),v=snap.val()||{};
    const rows=Object.keys(v).map(k=>v[k]).sort((a,b)=>b.at-a.at);
    p.innerHTML='<p class="hint">Last 100 admin actions.</p>'+(rows.length?'<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+fmtDT(r.at)+'</td><td>'+esc(r.by)+'</td><td>'+esc(r.action)+'</td><td style="white-space:normal;max-width:300px;font-size:.78rem;color:#64748b">'+esc(r.details||"")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">Nothing yet.</div>')}
  catch(e){p.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}

/* ----- Security ----- */
function adminSecurity(p){
  p.innerHTML='<form class="card" id="pwForm"><h3 style="margin-top:0">Change admin password</h3><div class="field"><label>Current password</label><input type="password" name="old" autocomplete="current-password" required></div><div class="field"><label>New password (10+ characters)</label><input type="password" name="n1" minlength="10" autocomplete="new-password" required></div><div class="field"><label>Repeat new password</label><input type="password" name="n2" minlength="10" autocomplete="new-password" required></div><button type="submit">Change password</button><p class="hint">Forgot it? Use “Send reset email” below, or reset it in Firebase console → Authentication.</p></form>'+
   '<div class="card"><h3 style="margin-top:0">Session</h3><p class="hint">Signed in as '+esc(adminUser.email||adminUser.uid)+'. The login ends when you close the browser tab.</p><div class="row"><button type="button" class="secondary" id="resetMail">Send reset email</button><button type="button" class="danger" id="logoutNow">Log out</button></div></div>';
  $("pwForm").onsubmit=async ev=>{ev.preventDefault();const f=ev.target.elements;if(f.n1.value!==f.n2.value){toast("New passwords do not match.","err");return}
    try{const cred=firebase.auth.EmailAuthProvider.credential(adminUser.email,f.old.value);await adminUser.reauthenticateWithCredential(cred);await adminUser.updatePassword(f.n1.value);ev.target.reset();toast("Password changed ✔","ok");audit("change_password",{})}
    catch(e){toast(/wrong|invalid|credential/.test(e.code||"")?"Current password is incorrect.":(e.message||"Could not change password."),"err")}};
  $("resetMail").onclick=async()=>{try{await auth.sendPasswordResetEmail(adminUser.email);toast("Reset email sent to "+adminUser.email,"ok")}catch(e){toast(e.message,"err")}};
  $("logoutNow").onclick=()=>$("logoutBtn").click();
}
})();
