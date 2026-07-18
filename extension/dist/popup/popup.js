import{p as L,a as C,b}from"../shared/erp-parser.js";function s(e){return document.getElementById(e)}function f(e,t){return chrome.runtime.sendMessage({type:e,payload:t})}const y=2*Math.PI*42;function $(e=new Date){const t=e.getFullYear(),n=`${e.getMonth()+1}`.padStart(2,"0"),a=`${e.getDate()}`.padStart(2,"0");return`${t}-${n}-${a}`}function h(e){const[t,n,a]=e.split("-").map(Number);return new Date(t,(n??1)-1,a??1).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric",weekday:"short"})}function E(e,t){const n=s("ring-fill"),a=y-e/100*y;n.style.strokeDasharray=`${y}`,n.style.strokeDashoffset=`${a}`,n.classList.remove("progress-ring__fill--safe","progress-ring__fill--warning","progress-ring__fill--critical"),t==="safe"?n.classList.add("progress-ring__fill--safe"):t==="warning"?n.classList.add("progress-ring__fill--warning"):t==="critical"&&n.classList.add("progress-ring__fill--critical")}function g(e,t,n="",a=""){const r=performance.now();function o(m){const u=m-r,l=Math.min(u/600,1),c=1-Math.pow(1-l,3),v=Math.round(0+(t-0)*c);e.textContent=n+v+a,l<1&&requestAnimationFrame(o)}requestAnimationFrame(o)}function M(e){return e.subjects.length?e.overall.status==="critical"?`Below 75%. Attend ${e.overall.recoveryClassesNeeded} straight class${e.overall.recoveryClassesNeeded===1?"":"es"} to recover.`:e.calendarSessions.length?e.overall.safeLeaveDays>0?`You can take ${e.overall.safeLeaveDays} full day${e.overall.safeLeaveDays===1?"":"s"} off and stay safe.`:e.overall.bunkableClasses>0?`You can miss ${e.overall.bunkableClasses} more class${e.overall.bunkableClasses===1?"":"es"}.`:"At the edge. Any absence drops you below 75%.":e.timetableSync.status==="error"?e.timetableSync.message??"Attendance imported. Timetable sync pending.":"Open NIET portal once to sync your class schedule.":"Open NIET ERP or import data to get started."}function p(e){const t=[e.student.studentName,e.student.semesterLabel].filter(Boolean);s("student-context").textContent=t.length>0?t.join(" • "):"NIET portal";const n=s("overall-percent");g(n,e.overall.attendancePercent),E(e.overall.attendancePercent,e.overall.status),s("headline").textContent=M(e);const a=s("sync-note");e.calendarSessions.length>0?a.textContent=e.timetableSync.rangeEnd?`Synced until ${e.timetableSync.rangeEnd}`:"Schedule synced":a.textContent=e.timetableSync.message??"Open portal to sync";const i=s("overall-status");i.textContent=e.overall.status,i.className=`status-pill status-pill--${e.overall.status}`;const d=s("stat-bunkable");g(d,e.overall.bunkableClasses);const r=s("stat-leave-days");g(r,e.overall.safeLeaveDays);const o=s("stat-next-miss");o.innerHTML=`-${e.overall.nextMissDropPercent}<span class="stat-card__unit">%</span>`;const m=s("stat-recovery");g(m,e.overall.recoveryClassesNeeded),N(e.subjects)}function N(e){const t=s("subjects-list");if(e.length===0){t.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="empty-state__title">No data yet</p>
        <p class="empty-state__desc">Open the NIET portal or paste attendance data in Settings to get started.</p>
      </div>
    `;return}const n=[...e].sort((a,i)=>{const d={critical:0,warning:1,safe:2};return(d[a.status]??3)-(d[i.status]??3)});t.innerHTML=n.map(a=>`
        <div class="subject-card subject-card--${a.status}">
          <div class="subject-card__top">
            <div class="subject-card__info">
              <div class="subject-card__name" title="${a.name}">${a.name}</div>
              <div class="subject-card__code">${a.code}</div>
            </div>
            <span class="subject-card__percent subject-card__percent--${a.status}">${a.status==="not-started"?"Not started":`${a.attendancePercent}%`}</span>
          </div>
          <div class="subject-card__meta">
            <span class="subject-card__bunks subject-card__bunks--${a.status}">${a.status==="not-started"?"No attendance yet":`${a.bunkableClasses} bunks left`}</span>
            <span class="subject-card__attendance">${a.attendedClasses}/${a.heldClasses} classes</span>
          </div>
          <div class="subject-card__bar">
            <div class="subject-card__bar-fill subject-card__bar-fill--${a.status}" style="width: ${Math.min(a.attendancePercent,100)}%"></div>
          </div>
        </div>
      `).join("")}function D(e){s("sim-result").classList.add("visible");const n=s("sim-result-title"),a=s("sim-result-status"),i=s("sim-result-body"),d=s("sim-result-stats"),r=s("sim-impact-summary"),o=s("sim-impact-list"),m=s("sim-class-list-wrap"),u=s("sim-class-list"),l=e.overall;n.textContent=`${l.beforePercent}% → ${l.afterPercent}%`,a.textContent=l.status,a.className=`status-pill status-pill--${l.status}`,l.afterPercent<75?i.textContent=`Not safe. Missing ${l.classesMissed} class${l.classesMissed===1?"":"es"} drops you to ${l.afterPercent}%. You'll need ${l.recoveryClassesNeeded} more classes to recover.`:i.textContent=`Safe. After missing ${l.classesMissed} class${l.classesMissed===1?"":"es"}, you'll be at ${l.afterPercent}%. You still have ${l.safeLeaveDaysRemaining} full leave day${l.safeLeaveDaysRemaining===1?"":"s"} left.`,d.innerHTML=`
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
  `,e.projections.length>0?(r.classList.remove("hidden"),o.innerHTML=e.projections.sort((c,v)=>v.classesMissed-c.classesMissed||c.subjectName.localeCompare(v.subjectName)).map(c=>`
          <div class="sim-impact-card">
            <div class="sim-impact-card__info">
              <strong>${c.subjectName}</strong>
              <span>Missed ${c.classesMissed} | ${c.beforePercent}% → ${c.afterPercent}%</span>
            </div>
            <span class="status-pill status-pill--${c.status}">${c.afterPercent}%</span>
          </div>
        `).join("")):(r.classList.add("hidden"),o.innerHTML=""),e.impactedSlots.length>0?(m.classList.remove("hidden"),u.innerHTML=e.impactedSlots.slice().sort((c,v)=>{const _=c.date.localeCompare(v.date);return _!==0?_:c.startTime.localeCompare(v.startTime)}).slice(0,10).map(c=>`
          <div class="sim-class-card">
            <div>
              <div class="sim-class-card__title">${c.subjectName}</div>
              <div class="sim-class-card__meta">${h(c.date)} · ${c.startTime} - ${c.endTime}</div>
            </div>
          </div>
        `).join(""),e.impactedSlots.length>10&&(u.innerHTML+=`<div class="sim-class-card" style="text-align:center;opacity:0.6;">+ ${e.impactedSlots.length-10} more classes</div>`)):(m.classList.add("hidden"),u.innerHTML="")}function S(){const e=document.querySelectorAll(".tab"),t=document.querySelectorAll(".tab-panel");e.forEach(n=>{n.addEventListener("click",()=>{const a=n.dataset.tab;e.forEach(i=>i.classList.remove("active")),t.forEach(i=>i.classList.remove("active")),n.classList.add("active"),s(`tab-${a}`).classList.add("active")})})}function T(){const e=s("sim-mode"),t=s("sim-leave-fields"),n=s("sim-range-fields"),a=s("sim-future-fields"),i=$();s("sim-from-date").value=i,s("sim-range-from").value=i;const d=new Date;d.setDate(d.getDate()+7),s("sim-range-to").value=$(d),e.addEventListener("change",()=>{t.classList.toggle("hidden",e.value!=="leave-days"),n.classList.toggle("hidden",e.value!=="date-range"),a.classList.toggle("hidden",e.value!=="future-count")}),s("btn-simulate").addEventListener("click",async()=>{const r=e.value,o={mode:r,subjectId:""};r==="leave-days"?(o.leaveDays=Number(s("sim-leave-days").value),o.fromDate=s("sim-from-date").value):r==="date-range"?(o.fromDate=s("sim-range-from").value,o.toDate=s("sim-range-to").value):r==="future-count"&&(o.futureClasses=Number(s("sim-future-count").value));const m=s("btn-simulate");m.textContent="Calculating...",m.disabled=!0;try{const u=await f("RUN_SIMULATION",o);if(u!=null&&u.success&&u.result){D(u.result);const l=await f("GET_DASHBOARD");l!=null&&l.success&&p(l.dashboard)}}catch(u){console.error("[Popup] Simulation failed:",u)}finally{m.textContent="Calculate Impact",m.disabled=!1}})}function x(){s("btn-import-paste").addEventListener("click",async()=>{const e=s("paste-data"),t=s("paste-result"),n=e.value.trim();if(!n){t.textContent="Paste some attendance data first.",t.className="settings-result settings-result--error";return}const i=n.includes("<table")||n.includes("</tr>")?L(n):C(n);if(i.length===0){t.textContent="Couldn't parse any subjects. Try the full attendance table.",t.className="settings-result settings-result--error";return}const d=b(i,"Imported from pasted data in extension popup.",[]);try{const r=await f("IMPORT_PASTED",d);r!=null&&r.success?(t.textContent=`Imported ${i.length} subjects successfully.`,t.className="settings-result settings-result--success",p(r.dashboard),e.value=""):(t.textContent=(r==null?void 0:r.error)??"Import failed.",t.className="settings-result settings-result--error")}catch{t.textContent="Failed to save data.",t.className="settings-result settings-result--error"}})}function P(){const e=s("btn-refresh");e.addEventListener("click",async()=>{e.classList.add("loading"),e.style.pointerEvents="none";try{const t=await f("SCRAPE_ACTIVE_TAB");if(t!=null&&t.success){p(t.dashboard),e.classList.remove("loading"),e.style.pointerEvents="";return}const n=s("headline");n.textContent=(t==null?void 0:t.error)??"Open NIET ERP tab to refresh.";const a=await f("GET_DASHBOARD");a!=null&&a.success&&p(a.dashboard)}finally{e.classList.remove("loading"),e.style.pointerEvents=""}})}async function w(){S(),T(),x(),P();try{const e=await f("GET_DASHBOARD");e!=null&&e.success&&p(e.dashboard)}catch(e){console.error("[Popup] Failed to load data:",e),s("headline").textContent="Couldn't load data. Try refreshing."}}w();
