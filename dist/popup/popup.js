import{p as b,a as h,b as L}from"../shared/erp-parser.js";function t(e){return document.getElementById(e)}function f(e,s){return chrome.runtime.sendMessage({type:e,payload:s})}const y=2*Math.PI*42;function $(e=new Date){const s=e.getFullYear(),n=`${e.getMonth()+1}`.padStart(2,"0"),a=`${e.getDate()}`.padStart(2,"0");return`${s}-${n}-${a}`}function C(e){const[s,n,a]=e.split("-").map(Number);return new Date(s,(n??1)-1,a??1).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric",weekday:"short"})}function E(e,s){const n=t("ring-fill"),a=y-e/100*y;n.style.strokeDasharray=`${y}`,n.style.strokeDashoffset=`${a}`,n.classList.remove("progress-ring__fill--safe","progress-ring__fill--warning","progress-ring__fill--critical"),s==="safe"?n.classList.add("progress-ring__fill--safe"):s==="warning"?n.classList.add("progress-ring__fill--warning"):s==="critical"&&n.classList.add("progress-ring__fill--critical")}function g(e,s,n="",a=""){const i=performance.now();function o(m){const u=m-i,l=Math.min(u/600,1),r=1-Math.pow(1-l,3),v=Math.round(0+(s-0)*r);e.textContent=n+v+a,l<1&&requestAnimationFrame(o)}requestAnimationFrame(o)}function M(e){return e.subjects.length?e.calendarSessions.length?e.overall.safeLeaveDays>0?`You can take ${e.overall.safeLeaveDays} full day${e.overall.safeLeaveDays===1?"":"s"} off and stay safe.`:e.overall.bunkableClasses>0?`You can miss ${e.overall.bunkableClasses} more class${e.overall.bunkableClasses===1?"":"es"}.`:"At the edge. Any absence drops you below 75%.":e.timetableSync.status==="error"?e.timetableSync.message??"Attendance imported. Timetable sync pending.":"Open NIET portal once to sync your class schedule.":"Open NIET ERP or import data to get started."}function p(e){const s=t("overall-percent");g(s,e.overall.attendancePercent),E(e.overall.attendancePercent,e.overall.status),t("headline").textContent=M(e);const n=t("sync-note");e.calendarSessions.length>0?n.textContent=e.timetableSync.rangeEnd?`Synced until ${e.timetableSync.rangeEnd}`:"Schedule synced":n.textContent=e.timetableSync.message??"Open portal to sync";const a=t("overall-status");a.textContent=e.overall.status,a.className=`status-pill status-pill--${e.overall.status}`;const c=t("stat-bunkable");g(c,e.overall.bunkableClasses);const d=t("stat-leave-days");g(d,e.overall.safeLeaveDays);const i=t("stat-next-miss");i.innerHTML=`-${e.overall.nextMissDropPercent}<span class="stat-card__unit">%</span>`;const o=t("stat-recovery");g(o,e.overall.recoveryClassesNeeded),D(e.subjects)}function D(e){const s=t("subjects-list");if(e.length===0){s.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="empty-state__title">No data yet</p>
        <p class="empty-state__desc">Open the NIET portal or paste attendance data in Settings to get started.</p>
      </div>
    `;return}const n=[...e].sort((a,c)=>{const d={critical:0,warning:1,safe:2};return(d[a.status]??3)-(d[c.status]??3)});s.innerHTML=n.map(a=>`
        <div class="subject-card subject-card--${a.status}">
          <div class="subject-card__top">
            <div class="subject-card__info">
              <div class="subject-card__name" title="${a.name}">${a.name}</div>
              <div class="subject-card__code">${a.code}</div>
            </div>
            <span class="subject-card__percent subject-card__percent--${a.status}">${a.attendancePercent}%</span>
          </div>
          <div class="subject-card__meta">
            <span class="subject-card__bunks subject-card__bunks--${a.status}">${a.bunkableClasses} bunks left</span>
            <span class="subject-card__attendance">${a.attendedClasses}/${a.heldClasses} classes</span>
          </div>
          <div class="subject-card__bar">
            <div class="subject-card__bar-fill subject-card__bar-fill--${a.status}" style="width: ${Math.min(a.attendancePercent,100)}%"></div>
          </div>
        </div>
      `).join("")}function S(e){t("sim-result").classList.add("visible");const n=t("sim-result-title"),a=t("sim-result-status"),c=t("sim-result-body"),d=t("sim-result-stats"),i=t("sim-impact-summary"),o=t("sim-impact-list"),m=t("sim-class-list-wrap"),u=t("sim-class-list"),l=e.overall;n.textContent=`${l.beforePercent}% → ${l.afterPercent}%`,a.textContent=l.status,a.className=`status-pill status-pill--${l.status}`,l.afterPercent<75?c.textContent=`Not safe. Missing ${l.classesMissed} class${l.classesMissed===1?"":"es"} drops you to ${l.afterPercent}%. You'll need ${l.recoveryClassesNeeded} more classes to recover.`:c.textContent=`Safe. After missing ${l.classesMissed} class${l.classesMissed===1?"":"es"}, you'll be at ${l.afterPercent}%. You still have ${l.safeLeaveDaysRemaining} full leave day${l.safeLeaveDaysRemaining===1?"":"s"} left.`,d.innerHTML=`
    <div class="sim-stat">
      <span class="sim-stat__label">Classes Missed</span>
      <span class="sim-stat__value">${l.classesMissed}</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Drop</span>
      <span class="sim-stat__value">-${l.deltaPercent}%</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Recovery Needed</span>
      <span class="sim-stat__value">${l.recoveryClassesNeeded}</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Leave Days Left</span>
      <span class="sim-stat__value">${l.safeLeaveDaysRemaining}</span>
    </div>
  `,e.projections.length>0?(i.classList.remove("hidden"),o.innerHTML=e.projections.sort((r,v)=>v.classesMissed-r.classesMissed||r.subjectName.localeCompare(v.subjectName)).map(r=>`
          <div class="sim-impact-card">
            <div class="sim-impact-card__info">
              <strong>${r.subjectName}</strong>
              <span>Missed ${r.classesMissed} | ${r.beforePercent}% → ${r.afterPercent}%</span>
            </div>
            <span class="status-pill status-pill--${r.status}">${r.afterPercent}%</span>
          </div>
        `).join("")):(i.classList.add("hidden"),o.innerHTML=""),e.impactedSlots.length>0?(m.classList.remove("hidden"),u.innerHTML=e.impactedSlots.slice().sort((r,v)=>{const _=r.date.localeCompare(v.date);return _!==0?_:r.startTime.localeCompare(v.startTime)}).slice(0,10).map(r=>`
          <div class="sim-class-card">
            <div>
              <div class="sim-class-card__title">${r.subjectName}</div>
              <div class="sim-class-card__meta">${C(r.date)} · ${r.startTime} - ${r.endTime}</div>
            </div>
          </div>
        `).join(""),e.impactedSlots.length>10&&(u.innerHTML+=`<div class="sim-class-card" style="text-align:center;opacity:0.6;">+ ${e.impactedSlots.length-10} more classes</div>`)):(m.classList.add("hidden"),u.innerHTML="")}function T(){const e=document.querySelectorAll(".tab"),s=document.querySelectorAll(".tab-panel");e.forEach(n=>{n.addEventListener("click",()=>{const a=n.dataset.tab;e.forEach(c=>c.classList.remove("active")),s.forEach(c=>c.classList.remove("active")),n.classList.add("active"),t(`tab-${a}`).classList.add("active")})})}function N(){const e=t("sim-mode"),s=t("sim-leave-fields"),n=t("sim-range-fields"),a=t("sim-future-fields"),c=$();t("sim-from-date").value=c,t("sim-range-from").value=c;const d=new Date;d.setDate(d.getDate()+7),t("sim-range-to").value=$(d),e.addEventListener("change",()=>{s.classList.toggle("hidden",e.value!=="leave-days"),n.classList.toggle("hidden",e.value!=="date-range"),a.classList.toggle("hidden",e.value!=="future-count")}),t("btn-simulate").addEventListener("click",async()=>{const i=e.value,o={mode:i,subjectId:""};i==="leave-days"?(o.leaveDays=Number(t("sim-leave-days").value),o.fromDate=t("sim-from-date").value):i==="date-range"?(o.fromDate=t("sim-range-from").value,o.toDate=t("sim-range-to").value):i==="future-count"&&(o.futureClasses=Number(t("sim-future-count").value));const m=t("btn-simulate");m.textContent="Calculating...",m.disabled=!0;try{const u=await f("RUN_SIMULATION",o);if(u!=null&&u.success&&u.result){S(u.result);const l=await f("GET_DASHBOARD");l!=null&&l.success&&p(l.dashboard)}}catch(u){console.error("[Popup] Simulation failed:",u)}finally{m.textContent="Calculate Impact",m.disabled=!1}})}function x(){t("btn-import-paste").addEventListener("click",async()=>{const e=t("paste-data"),s=t("paste-result"),n=e.value.trim();if(!n){s.textContent="Paste some attendance data first.",s.className="settings-result settings-result--error";return}const c=n.includes("<table")||n.includes("</tr>")?b(n):h(n);if(c.length===0){s.textContent="Couldn't parse any subjects. Try the full attendance table.",s.className="settings-result settings-result--error";return}const d=L(c,"Imported from pasted data in extension popup.",[]);try{const i=await f("IMPORT_PASTED",d);i!=null&&i.success?(s.textContent=`Imported ${c.length} subjects successfully.`,s.className="settings-result settings-result--success",p(i.dashboard),e.value=""):(s.textContent=(i==null?void 0:i.error)??"Import failed.",s.className="settings-result settings-result--error")}catch{s.textContent="Failed to save data.",s.className="settings-result settings-result--error"}})}function P(){const e=t("btn-refresh");e.addEventListener("click",async()=>{e.classList.add("loading"),e.style.pointerEvents="none";try{const s=await f("SCRAPE_ACTIVE_TAB");if(s!=null&&s.success){p(s.dashboard),e.classList.remove("loading"),e.style.pointerEvents="";return}const n=t("headline");n.textContent=(s==null?void 0:s.error)??"Open NIET ERP tab to refresh.";const a=await f("GET_DASHBOARD");a!=null&&a.success&&p(a.dashboard)}finally{e.classList.remove("loading"),e.style.pointerEvents=""}})}async function w(){T(),N(),x(),P();try{const e=await f("GET_DASHBOARD");e!=null&&e.success&&p(e.dashboard)}catch(e){console.error("[Popup] Failed to load data:",e),t("headline").textContent="Couldn't load data. Try refreshing."}}w();
