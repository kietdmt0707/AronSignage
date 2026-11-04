/* =====================================================================
   ARON Signage v2 – Lõi dùng chung cho player.html và admin.html
   (hiển thị slide, lịch ICS, thời tiết, KPI, âm thanh khẩn cấp, bộ nhớ offline)
   ===================================================================== */
const APP_VERSION='2.0.0';
// Thông tin kết nối lấy từ config.js (mỗi môi trường/project Supabase một file riêng)
const CFG=window.SIGNAGE_CONFIG||{};
const SB_URL=String(CFG.url||'').replace(/\/+$/,'');
const SB_KEY=String(CFG.key||'');
const SB_READY=/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SB_URL)&&SB_KEY.length>20;
const BUMP_CHANNEL='aron-signage-bump';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KINDS={birthday:['🎂','Chúc mừng sinh nhật','#ff7eb3,#ff758c'],kickoff:['🚀','Khởi động dự án','#4facfe,#00c6fb'],golive:['✅','Chúc mừng Go-live','#43e97b,#1a9e8f'],client:['🤝','Chào đón khách hàng mới','#fa709a,#f6a623'],team:['🏕️','Team building','#f093fb,#7b5cf0'],trip:['🏖️','Nghỉ dưỡng','#30cfd0,#330867'],sport:['⚽','Sự kiện thể thao','#f7971e,#e0412f'],other:['🎉','Thông báo','#667eea,#764ba2']};
const LBL={welcome:'Chào khách',meeting:'Lịch họp',event:'Sự kiện',video:'Video',image:'Ảnh',text:'Thông báo',countdown:'Đếm ngược',clock:'Đồng hồ',calendar:'Lịch tự động',room:'Phòng họp',weather:'Thời tiết',kpi:'KPI',web:'Trang web'};

function safeImg(u){
 if(typeof u!=='string')return '';
 if(/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(u))return u;
 if(/^https?:\/\/[^\s"'()<>\\]+$/i.test(u))return u;
 return '';
}
function safeMedia(u){if(typeof u!=='string')return '';u=u.trim();return /^(https?:|blob:)/i.test(u)?u:''}
function safeWeb(u){if(typeof u!=='string')return '';u=u.trim();return /^https:\/\/[^\s"'<>\\]+$/i.test(u)?u:''}
const yt=u=>{const m=String(u||'').match(/(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([\w-]{11})/);return m&&m[1]};

// Giờ chuẩn theo máy chủ (Tivi lệch giờ vẫn chạy lịch đúng)
let clockOffset=0;
const NOW=()=>new Date(Date.now()+clockOffset);
function syncClock(serverIso){const t=Date.parse(serverIso);if(!isNaN(t))clockOffset=t-Date.now()}
const today=()=>{const d=NOW();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
var renderTok=0,cdInt=null;

/* ===== ÂM THANH CẢNH BÁO (Web Audio) ===== */
var actx=null;
function audioCtx(){if(!actx){const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;try{actx=new C()}catch(e){return null}}return actx}
function audioReady(){const c=audioCtx();return !!(c&&c.state==='running')}
function tone(c,t,f,d,vol,type){const o=c.createOscillator(),g=c.createGain();o.type=type||'sine';o.frequency.setValueAtTime(f,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol,t+.025);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+d+.05)}
// Mỗi mức một kiểu âm: [thời điểm(s), tần số(Hz), độ dài(s)]
const ALERT_PATTERNS={
 red:[[0,880,.3],[.34,660,.3],[.78,880,.3],[1.12,660,.3],[1.56,880,.3],[1.9,660,.42]], // còi cao–thấp ×3
 orange:[[0,784,.45],[.42,659,.45],[.84,523,.75]],                                     // chuông 3 nốt đi xuống
 blue:[[0,659,.6],[.5,523,.9]]                                                          // ding-dong
};
// Còi khẩn cấp (đỏ): hi–lo dồn dập ×6 → tiếng hú vút lên → hi–lo ×6. Tiếng dày (vuông + sin), có lọc chói và nén chống rè.
function sirenVoice(c,dst,t,f,d,V){for(const [type,mul,k] of [['square',1,.32],['sine',1,.6],['sine',.5,.35]]){const o=c.createOscillator(),g=c.createGain();o.type=type;o.frequency.setValueAtTime(f*mul,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(V*k,t+.012);g.gain.setValueAtTime(V*k,t+d-.03);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(dst);o.start(t);o.stop(t+d+.02)}}
function siren(c,t,v){
 const bus=c.createGain(),lp=c.createBiquadFilter(),comp=c.createDynamicsCompressor();
 lp.type='lowpass';lp.frequency.value=3200;lp.Q.value=.7;comp.threshold.value=-14;comp.ratio.value=4;
 bus.connect(lp);lp.connect(comp);comp.connect(c.destination);
 const V=Math.min(.55,v*1.6);let x=t;
 for(let i=0;i<6;i++){sirenVoice(c,bus,x,i%2?740:988,.2,V);x+=.23}
 const o=c.createOscillator(),g=c.createGain(),o2=c.createOscillator(),g2=c.createGain();
 o.type='sawtooth';o2.type='sine';
 for(const [osc,gg,k] of [[o,g,.45],[o2,g2,.7]]){osc.frequency.setValueAtTime(600,x+.05);osc.frequency.exponentialRampToValueAtTime(1300,x+.75);gg.gain.setValueAtTime(.0001,x+.05);gg.gain.exponentialRampToValueAtTime(V*k,x+.12);gg.gain.setValueAtTime(V*k,x+.66);gg.gain.exponentialRampToValueAtTime(.0001,x+.8);osc.connect(gg);gg.connect(bus);osc.start(x+.05);osc.stop(x+.85)}
 x+=.95;
 for(let i=0;i<6;i++){sirenVoice(c,bus,x,i%2?740:988,.2,V);x+=.23}
}
function playAlert(level,vol){const c=audioCtx();if(!c||c.state!=='running')return false;const t=c.currentTime+.05,v=Math.min(.4,Math.max(.03,+vol||.18));
 if(level!=='orange'&&level!=='blue'){siren(c,t,v);return true}
 for(const [dt,f,d] of (ALERT_PATTERNS[level]||ALERT_PATTERNS.red)){tone(c,t+dt,f,d,v,'sine');tone(c,t+dt,f*2,d*.6,v*.22,'triangle')}return true}
/* ===== BỘ NHỚ OFFLINE & MẠNG ===== */
const withTimeout=(pr,ms,msg)=>Promise.race([pr,new Promise((_,rej)=>setTimeout(()=>rej(new Error(msg||'Hết thời gian chờ')),ms))]);
const IDB=(()=>{let dbp=null,broken=false;
 const open=()=>new Promise((res,rej)=>{try{if(!window.indexedDB)return rej(new Error('no idb'));const r=indexedDB.open('aron_signage',1);if(!r||typeof r!=='object'||!('onsuccess' in r))return rej(new Error('idb lỗi'));r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains('kv'))d.createObjectStore('kv');if(!d.objectStoreNames.contains('media'))d.createObjectStore('media')};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);r.onblocked=()=>rej(new Error('idb bị chặn'))}catch(e){rej(e)}});
 const db=()=>{if(broken)return Promise.reject(new Error('idb tắt'));return dbp||(dbp=withTimeout(open(),2500,'idb không phản hồi').catch(e=>{broken=true;console.warn('IndexedDB không dùng được, chạy không có bộ nhớ offline:',e.message);throw e}))};
 const op=async(st,mode,fn)=>{const d=await db();return withTimeout(new Promise((res,rej)=>{const t=d.transaction(st,mode),q=fn(t.objectStore(st));t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)}),st==='media'&&mode==='readwrite'?30000:4000,'idb chậm')};
 return{get:(st,k)=>op(st,'readonly',s=>s.get(k)),set:(st,k,v)=>op(st,'readwrite',s=>s.put(v,k)),del:(st,k)=>op(st,'readwrite',s=>s.delete(k)),keys:st=>op(st,'readonly',s=>s.getAllKeys()),get ok(){return !broken}};
})();
// fetch có giới hạn thời gian chờ: mạng chặn/treo sẽ báo lỗi thay vì "Đang tải" mãi
async function fetchT(url,ms,opt){
 const ac=window.AbortController?new AbortController():null,t=setTimeout(()=>{try{ac&&ac.abort()}catch(_){}},ms||9000);
 try{return await withTimeout(fetch(url,Object.assign({},opt||{},ac?{signal:ac.signal}:{})),(ms||9000)+500,'Hết thời gian chờ kết nối')}
 catch(e){if(e&&e.name==='AbortError')throw new Error('Hết thời gian chờ kết nối');throw e}
 finally{clearTimeout(t)}
}
const mediaURL=new Map();
const cachedURL=u=>(u&&mediaURL.get(u))||u;
// Lấy dữ liệu ngoài có cache: online → làm mới theo chu kỳ; offline/lỗi → dùng bản đã lưu
const memCache=new Map(); // dự phòng khi IndexedDB không dùng được
async function cachedFetch(key,ttlMin,fetcher){
 let c=memCache.get(key)||null;
 if(!c){try{c=await IDB.get('kv','c:'+key)||null}catch(_){}}
 if(c&&Date.now()-c.t<ttlMin*6e4)return{data:c.d,t:c.t};
 try{const d=await fetcher(),rec={d,t:Date.now()};memCache.set(key,rec);IDB.set('kv','c:'+key,rec).catch(()=>{});return{data:d,t:rec.t}}
 catch(e){if(c)return{data:c.d,t:c.t,stale:true};throw e}
}
// Lỗi mạng → câu báo dễ hiểu
function netErr(e,host){const m=String((e&&e.message)||e||'');
 if(/thời gian chờ|Failed to fetch|NetworkError|Load failed|network/i.test(m))return`Tivi không kết nối được tới ${host}. Kiểm tra mạng/tường lửa của Tivi (cần cho phép truy cập ${host}).`;
 return m}
const feedText=id=>cachedFetch('feed:'+id,10,async()=>{const r=await fetchT(SB_URL+'/functions/v1/feed?id='+encodeURIComponent(id),9000);if(!r.ok)throw new Error((await r.text().catch(()=>''))||('HTTP '+r.status));return r.text()});
const hhmm=d=>d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
const updLine=(r)=>`<div class="upd">${r.stale?'📴 Dữ liệu offline · ':''}Cập nhật ${hhmm(new Date(r.t))}</div>`;

/* ================= LỊCH ICS (Google / Outlook) ================= */
function icsDate(v,p){const m=String(v||'').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);if(!m)return null;const [,y,mo,d,h='0',mi='0',s='0',z]=m;return z?new Date(Date.UTC(+y,mo-1,+d,+h,+mi,+s)):new Date(+y,mo-1,+d,+h,+mi,+s)}
const ymd=d=>d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';
function icsDur(v){const m=String(v||'').match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);if(!m)return 0;return(((+m[1]||0)*7+(+m[2]||0))*86400+(+m[3]||0)*3600+(+m[4]||0)*60+(+m[5]||0))*1000}
function parseICS(txt){
 const lines=String(txt).replace(/\r?\n[ \t]/g,'').split(/\r?\n/),evs=[];let e=null;
 for(const l of lines){
  if(l==='BEGIN:VEVENT'){e={exdate:[]};continue}
  if(l==='END:VEVENT'){if(e&&e.start){if(!e.end)e.end=new Date(e.start.getTime()+(e.dur||(e.allDay?864e5:36e5)));evs.push(e)}e=null;continue}
  if(!e)continue;
  const i=l.indexOf(':');if(i<0)continue;
  const [name,...ps]=l.slice(0,i).split(';'),val=l.slice(i+1),p={};ps.forEach(x=>{const [a,b]=x.split('=');p[a]=b});
  const tx=v=>v.replace(/\\n/gi,' ').replace(/\\([,;\\])/g,'$1');
  switch(name){
   case 'UID':e.uid=val;break;
   case 'SUMMARY':e.summary=tx(val);break;
   case 'LOCATION':e.location=tx(val);break;
   case 'STATUS':e.status=val;break;
   case 'DTSTART':e.start=icsDate(val,p);e.allDay=p.VALUE==='DATE'||/^\d{8}$/.test(val);break;
   case 'DTEND':e.end=icsDate(val,p);break;
   case 'DURATION':e.dur=icsDur(val);break;
   case 'RRULE':e.rrule=Object.fromEntries(val.split(';').map(x=>x.split('=')));break;
   case 'EXDATE':val.split(',').forEach(v=>{const d=icsDate(v,p);if(d)e.exdate.push(ymd(d))});break;
   case 'RECURRENCE-ID':e.recid=icsDate(val,p);break;
  }
 }
 return evs;
}
const DOW=['SU','MO','TU','WE','TH','FR','SA'];
function ruleMatch(e,day){
 const r=e.rrule,st=new Date(e.start);st.setHours(0,0,0,0);if(day<st)return false;
 const iv=+r.INTERVAL||1,diffDays=Math.round((day-st)/864e5);
 switch(r.FREQ){
  case 'DAILY':return diffDays%iv===0&&(!r.BYDAY||r.BYDAY.split(',').includes(DOW[day.getDay()]));
  case 'WEEKLY':{const by=r.BYDAY?r.BYDAY.split(',').map(x=>x.slice(-2)):[DOW[st.getDay()]];if(!by.includes(DOW[day.getDay()]))return false;
   const wk=d=>{const x=new Date(d);x.setDate(x.getDate()-((x.getDay()+6)%7));x.setHours(0,0,0,0);return x};return Math.round((wk(day)-wk(st))/6048e5)%iv===0}
  case 'MONTHLY':{const months=(day.getFullYear()-st.getFullYear())*12+day.getMonth()-st.getMonth();if(months%iv)return false;
   if(r.BYDAY){const m=r.BYDAY.match(/^([+-]?\d)?([A-Z]{2})$/);if(!m||DOW[day.getDay()]!==m[2])return false;const n=+(m[1]||1);
    if(n>0)return Math.ceil(day.getDate()/7)===n;const last=new Date(day.getFullYear(),day.getMonth()+1,0).getDate();return -Math.ceil((last-day.getDate()+1)/7)===n}
   return day.getDate()===(+r.BYMONTHDAY||st.getDate())}
  case 'YEARLY':return day.getMonth()===st.getMonth()&&day.getDate()===st.getDate()&&(day.getFullYear()-st.getFullYear())%iv===0;
 }
 return false;
}
function occursOn(e,day){
 const r=e.rrule;if(!ruleMatch(e,day))return false;
 if(r.UNTIL){const u=icsDate(r.UNTIL,{});if(u&&ymd(day)>ymd(u))return false}
 if(r.COUNT){let c=0;const d=new Date(e.start);d.setHours(0,0,0,0);for(let k=0;k<3700&&d<=day;k++,d.setDate(d.getDate()+1)){if(ruleMatch(e,d))c++;if(c>+r.COUNT)return false}}
 return !e.exdate.includes(ymd(day));
}
function eventsOn(evs,day){
 const d0=new Date(day);d0.setHours(0,0,0,0);const ds=ymd(d0),out=[];
 const moved=new Set(evs.filter(e=>e.recid).map(e=>e.uid+'|'+ymd(e.recid)));
 for(const e of evs){
  if(e.status==='CANCELLED')continue;
  const len=Math.max(0,e.end-e.start);
  if(e.recid||!e.rrule){const s0=new Date(e.start);s0.setHours(0,0,0,0);const eEnd=new Date(e.end.getTime()-1);if(d0>=s0&&d0<=eEnd)out.push({...e});continue}
  if(moved.has(e.uid+'|'+ds))continue;
  if(occursOn(e,d0)){const st=new Date(d0);st.setHours(e.start.getHours(),e.start.getMinutes(),0,0);out.push({...e,start:st,end:new Date(st.getTime()+len)})}
 }
 return out.sort((a,b)=>(b.allDay-a.allDay)||(a.start-b.start));
}
async function loadCalendar(s,tok){
 const box=$('#xbox_'+tok);if(!box)return;
 try{
  if(!s.feed)throw new Error('Chưa cấu hình link lịch');
  const r=await feedText(s.feed);if(tok!==renderTok)return;
  const now=NOW(),evs=eventsOn(parseICS(r.data),now);
  const rows=evs.map(e=>{const cur=!e.allDay&&e.start<=now&&e.end>now,past=!e.allDay&&e.end<=now;
   return`<div class="mr ${cur?'now':''} ${past?'past':''}"><b>${e.allDay?'Cả ngày':hhmm(e.start)+'–'+hhmm(e.end)}</b><span>${esc(e.summary||'(Không tiêu đề)')}${cur?' <em class="live">● Đang diễn ra</em>':''}</span><i>${esc(e.location||'')}</i></div>`}).join('');
  box.innerHTML=(rows||'<div class="mid" style="text-align:center">Hôm nay không có cuộc họp</div>')+updLine(r);
 }catch(e){if(tok===renderTok)box.innerHTML=`<div class="mid" style="text-align:center">⚠️ Không tải được lịch</div><div class="sm2" style="text-align:center">${esc(netErr(e,'celqybfrjzrxvhlhtrqo.supabase.co'))}</div>`}
}

/* ================= THỜI TIẾT (Open-Meteo) ================= */
const WMO={0:['☀️','Trời quang'],1:['🌤️','Ít mây'],2:['⛅','Có mây'],3:['☁️','Nhiều mây'],45:['🌫️','Sương mù'],48:['🌫️','Sương mù'],51:['🌦️','Mưa phùn nhẹ'],53:['🌦️','Mưa phùn'],55:['🌧️','Mưa phùn dày'],56:['🌧️','Mưa phùn lạnh'],57:['🌧️','Mưa phùn lạnh'],61:['🌦️','Mưa nhẹ'],63:['🌧️','Mưa vừa'],65:['🌧️','Mưa to'],66:['🌧️','Mưa lạnh'],67:['🌧️','Mưa lạnh'],71:['🌨️','Tuyết nhẹ'],73:['🌨️','Tuyết'],75:['❄️','Tuyết dày'],80:['🌦️','Mưa rào nhẹ'],81:['🌧️','Mưa rào'],82:['⛈️','Mưa rào rất to'],95:['⛈️','Dông'],96:['⛈️','Dông, mưa đá'],99:['⛈️','Dông mạnh, mưa đá']};
const wmo=c=>WMO[c]||['🌡️',''];
async function loadWeather(s,tok){
 const box=$('#xbox_'+tok);if(!box)return;
 try{
  if(s.wlat==null)throw new Error('Chưa chọn thành phố');
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${+s.wlat}&longitude=${+s.wlon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=5`;
  const r=await cachedFetch('wx:'+s.wlat+','+s.wlon,30,async()=>{const x=await fetchT(url,8000);if(!x.ok)throw new Error('Máy chủ thời tiết trả lỗi '+x.status);return x.json()});
  if(tok!==renderTok)return;
  const c=r.data.current,d=r.data.daily,[ic,tx]=wmo(c.weather_code);
  const days=d.time.map((t,i)=>{const dt=new Date(t+'T00:00');const[di]=wmo(d.weather_code[i]);return`<div class="wx-d"><div class="wx-dn">${i===0?'Hôm nay':dt.toLocaleDateString('vi-VN',{weekday:'short'})}</div><div class="wx-di">${di}</div><div class="wx-dt"><b>${Math.round(d.temperature_2m_max[i])}°</b> ${Math.round(d.temperature_2m_min[i])}°</div><div class="wx-dp">💧${d.precipitation_probability_max[i]??0}%</div></div>`}).join('');
  box.innerHTML=`<div class="wx-now"><div class="wx-ic">${ic}</div><div style="text-align:left"><div class="wx-t">${Math.round(c.temperature_2m)}°C</div><div class="mid">${tx}</div><div class="sm2">Cảm giác ${Math.round(c.apparent_temperature)}° · 💧 ${c.relative_humidity_2m}% · 💨 ${Math.round(c.wind_speed_10m)} km/h</div></div></div><div class="wx-days">${days}</div>${updLine(r)}`;
 }catch(e){if(tok===renderTok)box.innerHTML=`<div class="mid">⚠️ Không tải được thời tiết</div><div class="sm2" style="max-width:70vw;margin:1vw auto 0">${esc(netErr(e,'api.open-meteo.com'))}</div>`;console.warn('Thời tiết:',e)}
}

/* ================= KPI ================= */
function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else if(c=='"')q=true;else if(c==','){row.push(f);f=''}else if(c=='\n'||c=='\r'){if(c=='\r'&&t[i+1]=='\n')i++;row.push(f);rows.push(row);row=[];f=''}else f+=c}if(f||row.length){row.push(f);rows.push(row)}return rows}
function num(v){v=String(v||'').replace(/\s|%/g,'');if(!v)return NaN;if(/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)||/^-?\d+,\d+$/.test(v))return parseFloat(v.replace(/\./g,'').replace(',','.'));return parseFloat(v.replace(/,/g,''))}
function kpiRows(rows){return rows.map(r=>r.map(x=>String(x||'').trim())).filter(r=>r[0]&&r.length>=2&&!isNaN(num(r[1])))}
function kpiHTML(rows){
 return '<div class="kpi-grid">'+rows.map(r=>{const v=num(r[1]),t=num(r[2]),has=!isNaN(t)&&t!==0,p=has?v/t*100:null,col=p==null?'#7b9bff':p>=100?'#43e97b':p>=70?'var(--hl)':'#ff6b6b';
  return`<div class="kpi"><div class="kpi-n">${esc(r[0])}</div><div><span class="kpi-v">${esc(r[1])}</span><span class="kpi-u">${esc(r[3]||'')}</span></div>${has?`<div class="kpi-bar"><i style="width:${Math.min(100,Math.max(0,p)).toFixed(1)}%;background:${col}"></i></div><div class="kpi-p">${p.toFixed(0)}% mục tiêu ${esc(r[2])}${r[3]?' '+esc(r[3]):''}</div>`:''}</div>`}).join('')+'</div>';
}
async function loadKPI(s,tok){
 const box=$('#xbox_'+tok);if(!box)return;
 try{
  let rows,r=null;
  if(s.feed){r=await feedText(s.feed);rows=kpiRows(parseCSV(r.data))}
  else rows=kpiRows((s.extra||'').split('\n').map(l=>l.split('|')));
  if(tok!==renderTok)return;
  box.innerHTML=(rows.length?kpiHTML(rows):'<div class="mid">Chưa có dữ liệu KPI</div>')+(r?updLine(r):'');
 }catch(e){if(tok===renderTok)box.innerHTML=`<div class="mid">⚠️ Không tải được KPI</div><div class="sm2">${esc(netErr(e,'celqybfrjzrxvhlhtrqo.supabase.co'))}</div>`}
}
/* ===== Mẫu hiển thị các loại slide có sẵn ===== */
function htmlBase(s,tok){const im0=safeImg(s.img),im=im0?cachedURL(im0):'',bg=im?`style="background-image:url(${im})"`:'',ov=(im&&s.imgov!==false)?'ov':'';
 if(s.type=='welcome')return`<div class="sl ${ov}" ${bg||'style="background:var(--sA)"'}><div class="mid script" style="font-size:4.4vw">Kính chào quý khách</div><div class="big">${esc(s.title)}</div><div class="mid">${esc(s.sub)}</div><div class="sm2">${esc(s.extra)}</div></div>`;
 if(s.type=='event'){const k=Object.prototype.hasOwnProperty.call(KINDS,s.kind)?KINDS[s.kind]:KINDS.other;return`<div class="sl ${ov}" style="${im?`background-image:url(${im})`:`background:linear-gradient(135deg,${k[2]})`}"><div class="emo">${k[0]}</div><div class="mid">${k[1]}</div><div class="big">${esc(s.title)}</div><div class="mid">${esc(s.sub)}</div><div class="sm2">${esc(s.extra)}</div></div>`}
 if(s.type=='meeting'){const rows=(s.extra||'').split('\n').filter(x=>x.trim()).map(l=>{const p=l.split('|').map(x=>x.trim());return`<div class="mr"><b>${esc(p[0])}</b><span>${esc(p[1])}</span><i>${esc(p[2]||'')}</i></div>`}).join('')||'<div class="mid">Hôm nay không có cuộc họp</div>';
  return`<div class="sl ${ov}" ${bg||'style="background:var(--sN)"'}><div class="mt"><h3>📅 Lịch họp hôm nay</h3>${rows}</div></div>`}
 if(s.type=='calendar')return`<div class="sl ${ov}" ${bg||'style="background:var(--sN)"'}><div class="mt"><h3>📅 ${esc(s.title||'Lịch họp hôm nay')}</h3><div class="sm2" style="text-align:center;margin:-1vw 0 1.5vw">${NOW().toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'long'})}</div><div id="xbox_${tok}"><div class="mid" style="text-align:center">Đang tải lịch...</div></div></div></div>`;
 if(s.type=='weather')return`<div class="sl ${ov}" ${bg||'style="background:var(--sA)"'}><div class="mid" style="font-weight:700">📍 ${esc(s.wname||s.wcity||'')}</div><div id="xbox_${tok}" style="width:100%"><div class="mid">Đang tải thời tiết...</div></div></div>`;
 if(s.type=='kpi')return`<div class="sl ${ov}" ${bg||'style="background:var(--sN)"'}><div class="mid" style="font-weight:800;margin-bottom:2vw">📊 ${esc(s.title||'Chỉ số KPI')}</div><div id="xbox_${tok}" style="width:100%;display:flex;flex-direction:column;align-items:center"><div class="mid">Đang tải...</div></div></div>`;
 if(s.type=='image')return im?`<div class="sl" style="padding:0;background:#000 url(${im}) center/${s.fit==='cover'?'cover':'contain'} no-repeat"></div>`:'<div class="sl"><div class="mid">Chưa có ảnh</div></div>';
 const y=s.type=='video'&&yt(s.vurl);if(y){const mP=s.sound?0:1;return`<div class="sl" style="background:#000;padding:0;overflow:hidden"><iframe id="yt_player" src="https://www.youtube.com/embed/${y}?enablejsapi=1&autoplay=1&mute=${mP}&controls=0&rel=0&playsinline=1&cc_load_policy=0&iv_load_policy=3&disablekb=1&fs=0&modestbranding=1" allow="autoplay; encrypted-media" style="position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;transform:scale(${s.ytcrop===false?1:1.16})"></iframe></div>`;}
 if(s.type=='text')return`<div class="sl ${ov}" ${bg||'style="background:var(--sA)"'}><div class="emo">📢</div><div class="big">${esc(s.title)}</div><div class="mid" style="white-space:pre-line">${esc(s.extra)}</div></div>`;
 if(s.type=='clock'){const d=NOW();return`<div class="sl ${ov}" ${bg||'style="background:var(--sN)"'}><div class="big" style="font-size:14vw">${d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</div><div class="mid">${d.toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div></div>`}
 if(s.type=='countdown'){return`<div class="sl ${ov}" ${bg||'style="background:var(--sN)"'}><div class="emo">⏳</div><div class="mid" style="font-size:3.5vw;font-weight:700">${esc(s.title)}</div><div id="cd_live_box" style="width:100%"></div><div class="mid" style="font-size:2.2vw">${esc(s.sub)}</div></div>`}
 if(s.type!=='video')return'<div class="sl"><div class="mid">⚠️ Loại nội dung này chưa được hỗ trợ</div><div class="sm2">Hãy tải lại trang để cập nhật ứng dụng</div></div>';
 const mutedAttr=s.sound?'':'muted';return`<div class="sl ${ov}" ${bg||'style="background:#000"'}><video id="v" autoplay ${mutedAttr} playsinline src="${esc(safeMedia(s.local||cachedURL(s.vurl)))}"></video></div>`}
function startLiveCountdown(targetStr){
 if(cdInt)clearInterval(cdInt);
 const el=$('#cd_live_box');if(!el)return;
 const target=new Date(targetStr).getTime();
 if(isNaN(target)){el.innerHTML='<div class="big" style="font-size:5vw">Chưa đặt thời gian</div>';return}
 const tick=()=>{
  const diff=target-Date.now();
  if(diff<=0){el.innerHTML='<div class="big" style="font-size:7vw;color:var(--hl)">🎉 SỰ KIỆN ĐANG DIỄN RA! 🎉</div>';return}
  const d=Math.floor(diff/864e5),h=Math.floor((diff/36e5)%24),m=Math.floor((diff/6e4)%60),s=Math.floor((diff/1000)%60),pad=n=>String(n).padStart(2,'0');
  el.innerHTML=`<div class="cd-grid"><div class="cd-box"><span class="cd-num">${d}</span><span class="cd-lbl">NGÀY</span></div><div class="cd-box"><span class="cd-num">${pad(h)}</span><span class="cd-lbl">GIỜ</span></div><div class="cd-box"><span class="cd-num">${pad(m)}</span><span class="cd-lbl">PHÚT</span></div><div class="cd-box"><span class="cd-num">${pad(s)}</span><span class="cd-lbl">GIÂY</span></div></div>`;
 };
 tick();cdInt=setInterval(tick,1000);
}


/* ================= PHÒNG HỌP (Trống / Đang họp từ lịch ICS) ================= */
async function loadRoom(s,tok){
 const box=$('#xbox_'+tok);if(!box)return;
 try{
  if(!s.feed)throw new Error('Chưa cấu hình link lịch phòng');
  const r=await feedText(s.feed);if(tok!==renderTok)return;
  const now=NOW(),evs=eventsOn(parseICS(r.data),now).filter(e=>!e.allDay);
  const curE=evs.find(e=>e.start<=now&&e.end>now),rest=evs.filter(e=>e.start>now),nx=rest[0];
  const mins=d=>Math.max(1,Math.round((d-now)/6e4));
  const sl=box.closest('.sl');if(sl){sl.classList.toggle('room-busy',!!curE);sl.classList.toggle('room-free',!curE)}
  box.innerHTML=`<div class="room-name">${esc(s.title||'Phòng họp')}</div>
   <div class="room-st">${curE?'● ĐANG HỌP':'✓ PHÒNG TRỐNG'}</div>
   ${curE?`<div class="room-cur">${esc(curE.summary||'(Không tiêu đề)')}</div><div class="room-time">${hhmm(curE.start)} – ${hhmm(curE.end)} · còn ${mins(curE.end)} phút</div>`
     :(nx?`<div class="room-time">Trống đến ${hhmm(nx.start)} (${mins(nx.start)} phút nữa)</div>`:`<div class="room-time">Không còn cuộc họp nào hôm nay</div>`)}
   ${rest.length?`<div class="room-next"><b>Tiếp theo</b>${rest.slice(0,3).map(e=>`<div><span>${hhmm(e.start)}–${hhmm(e.end)}</span>${esc(e.summary||'(Không tiêu đề)')}</div>`).join('')}</div>`:''}
   ${updLine(r)}`;
 }catch(e){if(tok===renderTok)box.innerHTML=`<div class="room-name">${esc(s.title||'Phòng họp')}</div><div class="mid">⚠️ Không tải được lịch phòng</div><div class="sm2">${esc(netErr(e,SB_URL.replace('https://','')))}</div>`}
}

/* ================= HIỂN THỊ 1 SLIDE ================= */
function html(s,tok){
 if(s.type==='room')return`<div class="sl room-free" style="background:var(--sN)"><div id="xbox_${tok}" class="room"><div class="mid">Đang tải lịch phòng...</div></div></div>`;
 if(s.type==='web'){const u=safeWeb(s.wurl);if(!u)return'<div class="sl"><div class="mid">Chưa có link trang web</div></div>';
  const z=Math.min(300,Math.max(25,+s.zoom||100))/100;
  return`<div class="sl" style="padding:0;background:#fff;animation-duration:.4s"><iframe src="${esc(u)}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms" style="position:absolute;top:0;left:0;border:0;width:${100/z}%;height:${100/z}%;transform:scale(${z});transform-origin:0 0"></iframe></div>`}
 return htmlBase(s,tok);
}

/* ================= TRÌNH PHÁT (dùng chung cho Tivi và xem trước) ================= */
const PL={dirty:false,slides:[],settings:{},alert:null,preview:null,running:false,cur:0,tm:null,onNow:null,offline:false};
function playerMarkup(){return`<div id="player" hidden><img id="player-logo" hidden alt=""><div id="emg" hidden></div><div id="ident" hidden></div>
 <div id="snd_hint" hidden>🔇 Chạm hoặc bấm vào màn hình 1 lần để bật âm thanh cảnh báo</div><div id="preview_tag" hidden>👁 XEM TRƯỚC · bấm Esc để thoát</div>
 <div id="net_tag" hidden>📴 Mất mạng – đang phát dữ liệu đã lưu</div>
 <div id="pg"></div><div id="body"><div id="stage"></div><div id="side"></div></div>
 <div id="bar"><span id="co"></span><span id="tk"><span></span></span><span id="clock"></span></div></div>`}

function activeSlides(list){const n=NOW(),hm=n.toTimeString().slice(0,5),d=today(),off=!navigator.onLine;
 return (list||[]).filter(s=>(!s.from||s.from<=d)&&(!s.to||s.to>=d)&&(!s.days||!Array.isArray(s.days)||s.days.includes(n.getDay()))&&(!s.t1||s.t1<=hm)&&(!s.t2||s.t2>=hm)
  &&!(off&&((s.type==='video'&&yt(s.vurl))||s.type==='web')))}
const alertActive=()=>{const a=PL.alert;return !!(a&&(!a.until||Date.parse(a.until)>NOW().getTime()))};

function setStage(h){
 const st=$('#stage'),olds=[...st.children];
 olds.forEach(o=>{o.querySelectorAll('video,iframe').forEach(m=>{try{m.pause&&m.pause()}catch(_){}m.remove()});o.querySelectorAll('[id]').forEach(x=>x.removeAttribute('id'));o.classList.add('out')});
 const d=document.createElement('div');d.className='layer';d.innerHTML=h;st.appendChild(d);
 setTimeout(()=>olds.forEach(o=>o.remove()),900);
}
let lastTicker=null;
function applyChrome(){
 const st=PL.settings||{};
 $('#co').textContent=st.company||'';
 if(lastTicker!==(st.ticker||'')){lastTicker=st.ticker||'';$('#tk span').textContent=lastTicker}
 const lg=safeImg(st.logo);if(lg){$('#player-logo').src=cachedURL(lg);$('#player-logo').hidden=false}else $('#player-logo').hidden=true;
 $('#net_tag').hidden=!PL.offline||!!PL.preview;
}
function plShow(){
 clearTimeout(PL.tm);if(cdInt){clearInterval(cdInt);cdInt=null}
 if(!PL.running)return;
 const tok=++renderTok;applyChrome();
 if(!PL.preview&&alertActive()){setStage('');renderEmergency();PL.tm=setTimeout(plShow,5000);report({type:'alert',title:'🚨 '+(PL.alert.title||'Khẩn cấp')});return}
 $('#emg').hidden=true;stopEmergencySound();updateSoundHint();
 let L=PL.preview?PL.preview:activeSlides(PL.slides);PL.dirty=false;
 const sp=PL.settings.lay==='side';$('#player').classList.toggle('sp',sp);
 if(sp){renderSide(PL.preview||PL.slides);if(!(PL.preview&&PL.preview.length===1)){const nm=L.filter(s=>s.type!=='meeting');if(nm.length)L=nm}}
 const pg=$('#pg');pg.style.transition='none';pg.style.width='0';
 if(!L.length){setStage('<div class="sl" style="background:var(--sN)"><div class="mid">Chưa có nội dung hiển thị</div><div class="sm2" style="opacity:.75;margin-top:1vw">Kiểm tra: nội dung đã được duyệt, đã chọn màn hình này, và khung ngày/giờ hiển thị</div></div>');PL.tm=setTimeout(plShow,15000);report(null);return}
 const s=L[PL.cur%L.length];PL.cur++;
 setStage(html(s,tok));report(s);
 if(s.type==='countdown')startLiveCountdown(s.target);
 if(s.type==='calendar')loadCalendar(s,tok);
 if(s.type==='weather')loadWeather(s,tok);
 if(s.type==='kpi')loadKPI(s,tok);
 if(s.type==='room'){loadRoom(s,tok);const iv=setInterval(()=>{if(tok!==renderTok)return clearInterval(iv);loadRoom(s,tok)},60000)}
 if(s.type==='video'){
  const v=$('#v');if(v){v.onended=v.onerror=()=>{if(tok===renderTok)plShow()}}
  const sec=(s.dur&&s.dur>0)?s.dur:(v?600:300);PL.tm=setTimeout(plShow,sec*1000);
  if(window.YT&&window.YT.Player&&$('#yt_player')){
   try{new YT.Player('yt_player',{events:{onReady:e=>{try{e.target.unloadModule('captions');e.target.unloadModule('cc')}catch(_){}},onStateChange:e=>{if(e.data===0&&tok===renderTok)plShow()},onError:e=>{console.warn('YouTube lỗi',e.data);setTimeout(()=>{if(tok===renderTok)plShow()},3000)}}})}catch(_){}
  }
 }else{
  const secs=Math.max(1,+s.dur||10);
  if(L.length>1||PL.preview)setTimeout(()=>{if(tok!==renderTok)return;pg.style.transition=`width ${secs}s linear`;pg.style.width='100%'},50);
  const again=()=>{if(L.length===1&&!PL.dirty&&!PL.preview&&!['clock','countdown','calendar','weather','kpi','room'].includes(s.type)&&activeSlides(PL.slides).length===1){PL.tm=setTimeout(again,secs*1000);return}plShow()};
  PL.tm=setTimeout(again,secs*1000);
 }
}
function report(s){try{PL.onNow&&PL.onNow(s)}catch(_){}}
function renderSide(list){
 const ms=activeSlides(list).filter(s=>s.type==='meeting').flatMap(s=>(s.extra||'').split('\n').filter(x=>x.trim())).sort(),sn=PL.settings.sidenote;
 $('#side').innerHTML='<div class="c" id="sc"></div><div class="d" id="sd"></div>'+(ms.length?'<h4>📅 Lịch họp hôm nay</h4>'+ms.map(l=>{const p=l.split('|').map(x=>x.trim());return`<div class="m"><b>${esc(p[0])}</b>${esc(p[1])}<i>${esc(p[2])}</i></div>`}).join(''):'')+(sn?`<div class="n">${esc(sn)}</div>`:'');tick();
}
function tick(){const n=NOW(),a=$('#sc');if(a){a.textContent=hhmm(n);$('#sd').textContent=n.toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'long'})}}
function clk(){tick();const c=$('#clock');if(c)c.textContent=NOW().toLocaleString('vi-VN',{weekday:'long',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
let clkInt=null;
function plStart(opt){
 opt=opt||{};PL.preview=opt.preview||null;PL.cur=0;PL.running=true;
 $('#preview_tag').hidden=!PL.preview;$('#player').hidden=false;
 clk();clearInterval(clkInt);clkInt=setInterval(clk,15000);
 if(opt.fullscreen){try{const r=document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();r&&r.catch&&r.catch(()=>{})}catch(_){}}
 unlockAudio();plShow();
}
function plStop(){
 PL.running=false;PL.preview=null;renderTok++;stopEmergencySound();clearTimeout(PL.tm);if(cdInt){clearInterval(cdInt);cdInt=null}
 $('#player').hidden=true;$('#stage').innerHTML='';$('#emg').hidden=true;
 if(document.fullscreenElement)try{document.exitFullscreen()}catch(_){}
}
const plNext=()=>{if(PL.running)plShow()};
// Cập nhật dữ liệu khi đang phát: chỉ chuyển slide ngay nếu trạng thái khẩn cấp thay đổi
function plSetData(d){
 const wasAlert=alertActive(),oldAlertId=PL.alert&&PL.alert.id;
 if(d.slides){if(JSON.stringify(d.slides)!==JSON.stringify(PL.slides))PL.dirty=true;PL.slides=d.slides}if(d.settings)PL.settings=d.settings;if('alert' in d)PL.alert=d.alert||null;
 if(!PL.running)return;
 applyChrome();
 const isAlert=alertActive();
 if(isAlert!==wasAlert||(isAlert&&PL.alert.id!==oldAlertId))plShow();
 else if(PL.settings.lay==='side'&&!PL.preview)renderSide(PL.slides);
 $('#player').classList.toggle('sp',PL.settings.lay==='side');
}
setInterval(()=>{if(PL.running&&!PL.preview){const a=alertActive(),shown=!$('#emg').hidden;if(a!==shown)plShow()}},5000);
function plIdentify(title,sub){
 const el=$('#ident');el.innerHTML=`<div class="id-t">${esc(title)}</div><div class="id-s">${esc(sub||'')}</div>`;el.hidden=false;
 clearTimeout(el._t);el._t=setTimeout(()=>el.hidden=true,15000);
}

/* ===== Khẩn cấp: hiển thị + âm thanh ===== */
var emgSoundAt=null,emgSoundTimer=null,emgSoundStart=0,emgNeedPlay=false;
function unlockAudio(){const c=audioCtx();if(c&&c.state==='suspended')c.resume().then(()=>{updateSoundHint();if(emgNeedPlay)handleEmergencySound(true)}).catch(()=>{});updateSoundHint()}
['pointerdown','keydown','touchstart'].forEach(ev=>addEventListener(ev,unlockAudio,{passive:true}));
function stopEmergencySound(keepKey){clearInterval(emgSoundTimer);emgSoundTimer=null;emgNeedPlay=false;if(!keepKey)emgSoundAt=null}
function handleEmergencySound(retry){
 const e=PL.alert,on=alertActive()&&PL.running&&!PL.preview;
 if(!on||!e.sound||e.sound==='off'){stopEmergencySound();updateSoundHint();return}
 if(emgSoundAt===e.id&&!retry)return;
 if(emgSoundAt!==e.id){stopEmergencySound();emgSoundAt=e.id;emgSoundStart=Date.now()}
 const ring=()=>{
  if(!alertActive()||PL.alert.id!==emgSoundAt||Date.now()-emgSoundStart>10*60e3){stopEmergencySound(true);return}
  emgNeedPlay=!playAlert(PL.alert.level,PL.alert.vol);updateSoundHint();
 };
 ring();const rep=+e.sound;if(rep>0&&!emgSoundTimer)emgSoundTimer=setInterval(ring,rep*1000);
}
function updateSoundHint(){const h=$('#snd_hint');if(!h)return;const show=PL.running&&!PL.preview&&!audioReady();h.hidden=!show;h.classList.toggle('urgent',show&&alertActive())}
function renderEmergency(){
 const e=PL.alert,el=$('#emg'),lv=['red','orange','blue'].includes(e.level)?e.level:'red';
 el.className='emg '+lv;
 el.innerHTML=`<div class="emg-ic">${lv==='blue'?'📣':'🚨'}</div><div class="emg-t">${esc(e.title)}</div><div class="emg-m">${esc(e.msg)}</div><div class="emg-time">Phát lúc ${hhmm(new Date(e.at))}</div>`;
 el.hidden=false;handleEmergencySound();
}

/* ===== Tải trước ảnh/video để phát khi mất mạng ===== */
let precaching=false;
async function precacheList(slides,extra,cleanup){
 if(precaching)return;precaching=true;
 try{
  const want=new Set((extra||[]).filter(u=>typeof u==='string'&&/^https:/.test(u)));
  for(const s of slides||[]){
   if(typeof s.img==='string'&&/^https:/.test(s.img))want.add(s.img);
   if(s.type==='video'&&s.vurl&&!yt(s.vurl)&&/^https:/.test(s.vurl))want.add(s.vurl);
  }
  for(const u of want){
   if(mediaURL.has(u))continue;
   let b=null;try{b=await IDB.get('media',u)}catch(_){}
   if(!b&&navigator.onLine){try{const r=await fetchT(u,120000,{mode:'cors'});if(r.ok){b=await r.blob();try{await IDB.set('media',u,b)}catch(_){}}}catch(_){}}
   if(b)mediaURL.set(u,URL.createObjectURL(b));
  }
  if(cleanup&&navigator.onLine){try{for(const k of await IDB.keys('media'))if(!want.has(k)){await IDB.del('media',k);const o=mediaURL.get(k);if(o){URL.revokeObjectURL(o);mediaURL.delete(k)}}}catch(_){}}
 }finally{precaching=false}
}
