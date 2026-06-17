// ===================== 16-0 — Multiplayer League: Draft =====================
// Parallel draft: every player drafts their own XI simultaneously (same spin
// engine as solo). Live pick sidebar via Supabase Realtime. Host drives bots.

const supa = (typeof initSupabase === "function" && initSupabase()) || (typeof supabaseClient !== "undefined" ? supabaseClient : null);
const PLAYER_ID = sessionStorage.getItem("mp_pid");
const ROOM = new URLSearchParams(location.search).get("room");

const $ = (id) => document.getElementById(id);
function toast(msg, kind = "") { const t = $("toast"); t.textContent = msg; t.className = "toast show " + kind; setTimeout(() => t.classList.remove("show"), 2200); }
function escapeHtml(v){ return String(v==null?"":v).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

if (!supa || !PLAYER_ID || !ROOM) { location.href = "lobby.html"; }

// ---------- engine state (ported from draft.js) ----------
const SLOT_LABELS = ["Opener","Opener","Opener / Middle Order","Middle Order","Middle Order","Middle Order","Middle Order / Finisher","Bowler / Finisher","Bowler","Bowler","Bowler"];
const MAX_OVERSEAS = 4;
let allPlayers = [], byTeamSeason = new Map(), spinPool = [], teamStrength = {}, fullNames = {}, fullToFr = {};
let mappedNames = {};
const spinState = { tier1Hits:0, tier2Hits:0, spinNumber:0 };
const xi = new Array(11).fill(null);

// ---------- room config ----------
let room = null, settings = {}, diff = { respins:1, enforceWk:true }, blind = false, isPrime = false, eraFrom = 2008, eraTo = 2026, isHost = false;
let pendingSquad = null, currentTeam = null, rerollsLeft = 0, spinning = false, finished = false;
let players = [], me = null;
let timer = null, timeLeft = 60;
const lastSeen = {}; // pid -> last pick count, for flash

// ===================== boot =====================
(async function boot() {
  const { data: r } = await supa.from("rooms").select("*").eq("id", ROOM).single();
  if (!r) { location.href = "lobby.html"; return; }
  room = r; settings = r.settings || {};
  isHost = r.host_id === PLAYER_ID;
  $("roomName").textContent = r.name || "League";
  // settings
  const d = settings.difficulty || "normal";
  diff = d === "easy" ? { respins:3, enforceWk:false } : d === "hard" ? { respins:0, enforceWk:true } : { respins:1, enforceWk:true };
  blind = d === "hard";
  isPrime = settings.ratings === "prime";
  eraFrom = settings.era && settings.era !== "all" ? +settings.era : 2008;
  eraTo = 2026;
  rerollsLeft = diff.respins;

  await loadData();
  await refreshPlayers();
  subscribe();
  renderSidebar();
  resetTimer();
  updateMeta();

  if (isHost) driveBots();
})();

// ===================== CSV + engine data (mirrors draft.js buildData) =====================
function loadCsv(path){ return new Promise((res,rej)=>Papa.parse(path,{download:true,header:true,skipEmptyLines:true,complete:(r)=>res(r.data),error:rej})); }
async function loadData() {
  let nameRows = [];
  try { nameRows = await loadCsv("mapped_names.csv"); } catch(_){}
  nameRows.forEach((r)=>{ const m=(r.Master_DB_Name||"").trim(), d=(r.Impact_CSV_Name||"").trim(); if(m&&d) mappedNames[m]=d; });
  const rows = await loadCsv("ipl_master_calibrated.csv");

  allPlayers = rows.filter((r)=>r.Player_Name&&r.Franchise&&r.Season).map((r)=>({
    name:r.Player_Name, displayName:mappedNames[(r.Player_Name||"").trim()]||r.Player_Name,
    season:r.Season, fr:r.Franchise, frFull:r.Franchise_Full||r.Franchise,
    primaryRole:r.Primary_Role, battingOrder:r.Batting_Order,
    isWk:r.Is_Wicketkeeper==="1", isOverseas:r.Nationality==="Overseas",
    ovr:+r.OVR||0, bat:+r.Bat_Rat||0, bowl:+r.Bowl_Rat||0,
  }));
  const primeBest = {};
  for (const p of allPlayers){ const pr=primeBest[p.name]; if(!pr||p.ovr>pr.ovr) primeBest[p.name]=p; }
  for (const p of allPlayers){ const key=`${p.fr}|${p.season}`; if(!byTeamSeason.has(key)) byTeamSeason.set(key,[]); byTeamSeason.get(key).push(p); fullNames[p.fr]=p.frFull; fullToFr[p.frFull]=p.fr; }
  if (isPrime){ for(const p of allPlayers){ const b=primeBest[p.name]; if(b){ p.ovr=b.ovr;p.bat=b.bat;p.bowl=b.bowl;p.season=b.season; } } }
  for (const [key,squad] of byTeamSeason){ if(squad.length<11) continue; const top=squad.map((p)=>p.ovr).sort((a,b)=>b-a).slice(0,5); teamStrength[key]=top.reduce((a,b)=>a+b,0)/top.length; }
  spinPool = Object.entries(teamStrength).map(([key,avgOVR])=>{ const [fr,season]=key.split("|"); return {fr,season,avgOVR}; });
}

// ===================== engine fns (ported) =====================
function eligibleSlots(p){
  let slots;
  if (p.primaryRole==="Bowler") slots=[7,8,9,10];
  else switch(p.battingOrder){
    case "Opener": slots=[0,1,2]; break;
    case "Middle Order": slots=[2,3,4,5]; break;
    case "Finisher": slots=[6,5,4]; break;
    case "Lower Order": slots=[7,8,9,10,6]; break;
    default: slots=[2,3,4,5,6,7,8,9,10];
  }
  const has6=slots.includes(6);
  if (canFillSlot7(p)&&!has6) slots=[...slots,6];
  else if (!canFillSlot7(p)&&has6) slots=slots.filter((s)=>s!==6);
  return slots;
}
function canFillSlot7(p){
  if (p.battingOrder==="Opener") return false;
  if (p.primaryRole==="Bowler"&&p.battingOrder==="Lower Order") return false;
  return p.battingOrder==="Finisher"||p.battingOrder==="Middle Order"||p.isWk||p.primaryRole==="All-Rounder";
}
const inXi=(name)=>xi.some((p)=>p&&p.name===name);
const overseasCount=()=>xi.filter((p)=>p&&p.isOverseas).length;
function getDangerWkSlot(){
  if(!diff.enforceWk) return null;
  const top7=xi.slice(0,7);
  if(top7.some((p)=>p&&p.isWk)) return null;
  const empty=[]; for(let i=0;i<7;i++) if(xi[i]===null) empty.push(i);
  return empty.length===1?empty[0]:null;
}
function slotFor(p){ const reserved=getDangerWkSlot()??-1; return eligibleSlots(p).find((i)=>xi[i]===null&&(p.isWk||i!==reserved)); }
function canDraft(p){
  if(inXi(p.name)) return false;
  if(p.isOverseas&&overseasCount()>=MAX_OVERSEAS) return false;
  const danger=getDangerWkSlot();
  if(danger!==null&&!p.isWk){ const low=[7,8,9,10].filter((i)=>xi[i]===null&&eligibleSlots(p).includes(i)); if(low.length===0) return false; }
  return slotFor(p)!==undefined;
}
function getTeamTier(a){ return a>=84?1:a>=81?2:3; }
function getSpinWeights(s){ let w1=42,w2=33,w3=25; const t1=Math.max(0,s.tier1Hits-1)*5; w1=Math.max(30,w1-t1); const t2=Math.max(0,s.tier2Hits-2)*2; w2=Math.max(26,w2-t2); w3+=t1+t2; return {w1,w2,w3}; }
const tierWeight=(t,w)=>t===1?w.w1:t===2?w.w2:w.w3;
function weightedPick(items,wOf){ const tot=items.reduce((a,it)=>a+wOf(it),0); let r=Math.random()*tot; for(const it of items){ r-=wOf(it); if(r<=0) return it; } return items[items.length-1]; }
function pickTeam(forceWk=false){
  let valid=spinPool.filter((e)=>{ if(+e.season<eraFrom||+e.season>eraTo) return false; const sq=byTeamSeason.get(`${e.fr}|${e.season}`)||[]; return sq.some((p)=>canDraft(p)&&(!forceWk||p.isWk)); });
  if(!valid.length) valid=spinPool.filter((e)=>{ const sq=byTeamSeason.get(`${e.fr}|${e.season}`)||[]; return sq.some((p)=>canDraft(p)&&(!forceWk||p.isWk)); });
  if(!valid.length) valid=spinPool.filter((e)=>{ const sq=byTeamSeason.get(`${e.fr}|${e.season}`)||[]; return sq.some((p)=>canDraft(p)); });
  if(!valid.length) return spinPool[Math.floor(Math.random()*spinPool.length)];
  const w=getSpinWeights(spinState);
  const counts=valid.reduce((c,e)=>{ const t=getTeamTier(e.avgOVR); c[t]=(c[t]||0)+1; return c; },{});
  const entry=weightedPick(valid,(e)=>{ const t=getTeamTier(e.avgOVR); return tierWeight(t,w)/(counts[t]||1); });
  const t=getTeamTier(entry.avgOVR); if(t===1) spinState.tier1Hits++; if(t===2) spinState.tier2Hits++; spinState.spinNumber++;
  return { fr:entry.fr, season:entry.season };
}

// ===================== spin + render =====================
const eraAbbr=(fr,s)=>{ const y=+s||0; if(fr==="PBKS") return y<=2020?"KXIP":"PBKS"; if(fr==="DC") return y<=2018?"DD":"DC"; return fr; };
const eraFullName=(fr,s)=>{ const y=+s||0; if(fr==="PBKS") return y<=2020?"Kings XI Punjab":"Punjab Kings"; if(fr==="DC") return y<=2018?"Delhi Daredevils":"Delhi Capitals"; if(fr==="RCB") return y<=2023?"Royal Challengers Bangalore":"Royal Challengers Bengaluru"; return fullNames[fr]||fr; };
const tierClass=(o)=>o>=92?"gold":o>=89?"blue":o>=85?"green":"white";
const roleClass=(p)=>({Opener:"op","Middle Order":"mid",Finisher:"fin","Lower Order":"low"}[p.battingOrder]||"mid");
const label=(p)=>p.displayName||p.name;

$("spinBtn").onclick = () => doSpin(false);
$("rerollBtn").onclick = () => { if (rerollsLeft>0){ rerollsLeft--; doSpin(true); } };

function doSpin(isReroll){
  if (spinning || finished) return;
  const need = getDangerWkSlot()!==null; // must land a WK-capable squad
  spinning = true;
  $("spinBtn").disabled = true;
  const target = pickTeam(need);
  // animate reels
  const clubEl=$("reelClub"), seasonEl=$("reelSeason");
  clubEl.classList.add("rolling"); seasonEl.classList.add("rolling");
  let ticks=0; const total=12;
  const iv=setInterval(()=>{
    const rnd=spinPool[Math.floor(Math.random()*spinPool.length)];
    clubEl.textContent = eraFullName(rnd.fr, rnd.season);
    seasonEl.textContent = rnd.season;
    if (++ticks>=total){
      clearInterval(iv);
      clubEl.textContent = eraFullName(target.fr, target.season);
      seasonEl.textContent = target.season;
      clubEl.classList.remove("rolling"); seasonEl.classList.remove("rolling");
      currentTeam = target;
      pendingSquad = (byTeamSeason.get(`${target.fr}|${target.season}`)||[]).slice();
      spinning=false;
      renderSquad();
      updateMeta();
    }
  }, 90);
}

function renderSquad(){
  const grid=$("squadGrid"); grid.innerHTML="";
  if(!pendingSquad) return;
  let pool=[...pendingSquad];
  if(blind) for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  pool.sort((a,b)=>{ const ca=canDraft(a),cb=canDraft(b); if(ca!==cb) return ca?-1:1; if(blind) return 0; return b.ovr-a.ovr; });
  pool.forEach((p)=>{
    const blocked=!canDraft(p);
    const card=document.createElement("button");
    card.type="button"; card.className="card"+(blocked?" blocked":"");
    const ovrHtml = blind ? "" : `<span class="ovr ${tierClass(p.ovr)}">${p.ovr}</span>`;
    const sub = blind ? "" : `<div class="card-sub">${eraAbbr(p.fr,p.season)} · ${p.season}</div>`;
    card.innerHTML = `
      <div class="card-top"><span class="card-name">${escapeHtml(label(p))}</span>${ovrHtml}</div>
      <div class="card-meta">
        <span class="rb ${roleClass(p)}">${p.battingOrder}</span>
        ${p.isWk?'<span class="wk">WK</span>':""}
        ${p.isOverseas?'<span class="plane">✈</span>':""}
      </div>${sub}`;
    if(!blocked) card.onclick=()=>draftPlayer(p);
    grid.appendChild(card);
  });
}

// ===================== draft a pick =====================
async function draftPlayer(p){
  if(finished||!p) return;
  const slot=slotFor(p);
  if(slot===undefined){ toast("No open slot for that player","err"); return; }
  xi[slot]=p;
  pendingSquad=null;
  $("squadGrid").innerHTML="";
  renderXI(); updateMeta();
  resetTimer();
  await saveProgress();
  if (xi.filter(Boolean).length>=11) finishDraft();
}

function renderXI(){
  const list=$("xiList"); list.innerHTML="";
  SLOT_LABELS.forEach((lbl,i)=>{
    const p=xi[i];
    const li=document.createElement("li");
    li.innerHTML = p
      ? `<span class="xi-num">${i+1}</span><span class="xi-name">${escapeHtml(label(p))}${p.isWk?' <span class="wk">WK</span>':""}</span><span class="xi-povr">${blind?"":p.ovr}</span>`
      : `<span class="xi-num">${i+1}</span><span class="xi-name xi-empty">${lbl}</span>`;
    list.appendChild(li);
  });
  $("pickCount").textContent = xi.filter(Boolean).length;
  $("osCount").textContent = overseasCount();
}

function updateMeta(){
  const picked=xi.filter(Boolean).length;
  $("roundLabel").textContent = `Pick ${Math.min(picked+1,11)} / 11`;
  const sb=$("spinBtn"), rb=$("rerollBtn");
  if (finished){ sb.classList.add("hidden"); rb.classList.add("hidden"); $("spinMeta").textContent="XI complete."; return; }
  if (pendingSquad){
    sb.classList.add("hidden");
    if (rerollsLeft>0){ rb.classList.remove("hidden"); $("rerollLeft").textContent=rerollsLeft; }
    else rb.classList.add("hidden");
    $("spinMeta").textContent = getDangerWkSlot()!==null ? "Need a wicketkeeper in your top 7 — pick a WK" : "Pick one player from this squad";
  } else {
    sb.classList.remove("hidden"); sb.disabled=false; rb.classList.add("hidden");
    $("spinMeta").textContent = picked===0 ? "Spin for your first club" : "Spin for your next pick";
  }
}

// ===================== timer (60s/pick, auto-pick on expiry) =====================
function resetTimer(){
  clearInterval(timer); timeLeft=60;
  const el=$("timer"); el.textContent=60; el.className="timer";
  timer=setInterval(()=>{
    timeLeft--;
    el.textContent=Math.max(0,timeLeft);
    el.className = "timer"+(timeLeft<=10?" crit":timeLeft<=20?" warn":"");
    if(timeLeft<=0){ clearInterval(timer); autoPick(); }
  },1000);
}
function autoPick(){
  if(finished) return;
  if(!pendingSquad){ const t=pickTeam(getDangerWkSlot()!==null); currentTeam=t; pendingSquad=(byTeamSeason.get(`${t.fr}|${t.season}`)||[]).slice(); }
  const choices=pendingSquad.filter(canDraft).sort((a,b)=>b.ovr-a.ovr);
  if(choices.length){ toast("Auto-picked (time up)"); draftPlayer(choices[0]); }
  else { pendingSquad=null; resetTimer(); updateMeta(); }
}

// ===================== persistence + sidebar =====================
function xiPayload(){
  return xi.map((p,slot)=> p ? {
    name:p.displayName||p.name, ovr:p.ovr, bat:p.bat, bowl:p.bowl, fr:p.fr, season:p.season,
    isWk:p.isWk, isOverseas:p.isOverseas, primaryRole:p.primaryRole, battingOrder:p.battingOrder, slot,
  } : null).filter(Boolean);
}
async function saveProgress(){
  const filled=xi.filter(Boolean).length;
  await supa.from("players").update({ xi:xiPayload(), status: filled>=11?"done":"drafting" }).eq("id",PLAYER_ID).eq("room_id",ROOM);
}
async function refreshPlayers(){
  const { data } = await supa.from("players").select("*").eq("room_id",ROOM).order("joined_at",{ascending:true});
  players=data||[]; me=players.find((p)=>p.id===PLAYER_ID);
}

function subscribe(){
  const ch=supa.channel("draft:"+ROOM);
  ch.on("postgres_changes",{event:"*",schema:"public",table:"players",filter:`room_id=eq.${ROOM}`}, async ()=>{ await refreshPlayers(); renderSidebar(); checkAllDone(); });
  ch.on("postgres_changes",{event:"*",schema:"public",table:"rooms",filter:`id=eq.${ROOM}`}, (pl)=>{ const nr=pl.new; if(nr&&nr.status==="league") gotoSim(); });
  ch.subscribe();
}

function renderSidebar(){
  const list=$("sbList"); if(!list) return;
  list.innerHTML = players.map((p)=>{
    const cnt = Array.isArray(p.xi)?p.xi.length:0;
    const last = cnt? (p.xi[cnt-1].name) : "—";
    const rem = 11-cnt;
    const flash = lastSeen[p.id]!==undefined && cnt>lastSeen[p.id];
    lastSeen[p.id]=cnt;
    const init=(p.username||"?").trim()[0]?.toUpperCase()||"?";
    return `<li class="${flash?"flash":""} ${p.id===PLAYER_ID?"me":""}">
      <span class="sb-mono ${p.is_bot?"bot":""}">${init}</span>
      <span class="sb-name">${escapeHtml(p.username)}</span>
      <span class="sb-pick">${cnt?escapeHtml(last):"waiting…"}</span>
      <span class="sb-rem">${rem>0?rem+" left":"✓ done"}</span>
    </li>`;
  }).join("");
  setTimeout(()=>list.querySelectorAll(".flash").forEach((el)=>el.classList.remove("flash")),700);
}

// ===================== bots (host drives) =====================
function buildBotXI(botFullName){
  const fr=fullToFr[botFullName]; if(!fr) return [];
  const squad=(byTeamSeason.get(`${fr}|2026`)||[]).slice().sort((a,b)=>b.ovr-a.ovr);
  const slots=new Array(11).fill(null);
  const inTeam=(n)=>slots.some((x)=>x&&x.name===n);
  const os=()=>slots.filter((x)=>x&&x.isOverseas).length;
  const dangerWk=()=>{ const top7=slots.slice(0,7); if(top7.some((x)=>x&&x.isWk)) return null; const e=[]; for(let i=0;i<7;i++) if(slots[i]===null) e.push(i); return e.length===1?e[0]:null; };
  const slotForBot=(p)=>{ const res=dangerWk()??-1; return eligibleSlots(p).find((i)=>slots[i]===null&&(p.isWk||i!==res)); };
  for (const p of squad){
    if (slots.every((x)=>x)) break;
    if (inTeam(p.name)) continue;
    if (p.isOverseas&&os()>=MAX_OVERSEAS) continue;
    const dw=dangerWk();
    if (dw!==null&&!p.isWk){ const low=[7,8,9,10].filter((i)=>slots[i]===null&&eligibleSlots(p).includes(i)); if(!low.length) continue; }
    const s=slotForBot(p); if(s===undefined) continue;
    slots[s]=p;
  }
  return slots.map((p,slot)=> p?{name:p.displayName||p.name,ovr:p.ovr,bat:p.bat,bowl:p.bowl,fr:p.fr,season:p.season,isWk:p.isWk,isOverseas:p.isOverseas,primaryRole:p.primaryRole,battingOrder:p.battingOrder,slot}:null).filter(Boolean);
}
async function driveBots(){
  const bots=players.filter((p)=>p.is_bot && (!Array.isArray(p.xi)||p.xi.length<11));
  for (const bot of bots){
    const full=buildBotXI(bot.bot_team||bot.username);
    // reveal progressively for live flavour
    for (let n=1;n<=full.length;n++){
      await new Promise((r)=>setTimeout(r, 600+Math.random()*900));
      await supa.from("players").update({ xi:full.slice(0,n), status: n>=full.length?"done":"drafting" }).eq("id",bot.id).eq("room_id",ROOM);
    }
  }
}

// ===================== finish + transition =====================
function finishDraft(){
  finished=true;
  clearInterval(timer);
  $("timer").textContent="✓"; $("timer").className="timer";
  $("sidebar").classList.add("hidden");
  $("doneBar").classList.remove("hidden");
  updateMeta();
  toast("XI complete!");
  const btn=$("doneBtn"); btn.disabled=false; btn.textContent="Ready for Simulation";
  btn.onclick = async ()=>{ btn.disabled=true; btn.textContent="Waiting for others…"; await supa.from("players").update({ status:"ready_sim", xi:xiPayload() }).eq("id",PLAYER_ID).eq("room_id",ROOM); checkAllDone(); };
}

let transitioning=false;
async function checkAllDone(){
  if (!isHost || transitioning) return;
  const humans=players.filter((p)=>!p.is_bot);
  const bots=players.filter((p)=>p.is_bot);
  const humansReady = humans.length>0 && humans.every((p)=>p.status==="ready_sim");
  const botsDone = bots.every((p)=>Array.isArray(p.xi)&&p.xi.length>=11);
  if (humansReady && botsDone){
    transitioning=true;
    await supa.from("rooms").update({ status:"league" }).eq("id",ROOM);
  }
}

let redirecting=false;
function gotoSim(){
  if(redirecting) return; redirecting=true;
  clearInterval(timer);
  const ov=document.createElement("div"); ov.className="countdown"; document.body.appendChild(ov);
  let n=3; (function tick(){ ov.innerHTML=`<div class="num">${n}</div>`; if(n-->0) setTimeout(tick,1000); else location.href=`sim-mp.html?room=${ROOM}`; })();
}

// ---------- misc UI ----------
$("xiHead").onclick = ()=> $("xiList").classList.toggle("collapsed");
$("sbToggle").onclick = ()=>{ const l=$("sbList"); l.classList.toggle("min"); $("sbToggle").textContent=l.classList.contains("min")?"▴":"▾"; };
$("leaveBtn").onclick = async ()=>{ try{ await supa.from("players").delete().eq("id",PLAYER_ID).eq("room_id",ROOM); }catch(_){}; location.href="index.html"; };
