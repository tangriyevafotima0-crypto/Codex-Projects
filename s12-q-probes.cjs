// Guarded ephemeral CI data only. Semantic observations require explicit assessment.
const crypto=require('node:crypto');
const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C,SYNTHETIC_TEST_ONLY_PASSWORD:password}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {createApiApplication}=require('./eduerp-v2/apps/api/dist/src/application');
const {loadApiEnv}=require('./eduerp-v2/apps/api/dist/src/config/env');
const {ClockService}=require('./eduerp-v2/apps/api/dist/src/auth/clock.service');
(async()=>{const e=await createEphemeralTestDbEnv();let app;try{
await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
const enrollment=crypto.randomUUID(),cycle=crypto.randomUUID(),invoice=crypto.randomUUID(),shift=crypto.randomUUID();
await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-11-01')`,[enrollment,C.centerId,C.studentId,C.groupId]);
await e.apiPoolA.query(`INSERT INTO billing_cycles(id,center_id,enrollment_id,cycle_type,cycle_key,cycle_seq,period_start_date,period_end_date,planned_lessons,billable_lessons,policy_version_id) VALUES($1,$2,$3,'CALENDAR_MONTH','CAL:2026-11',1,'2026-11-01','2026-11-30',12,12,$4)`,[cycle,C.centerId,enrollment,C.billingPolicyId]);
await e.apiPoolA.query(`INSERT INTO invoices(id,center_id,invoice_number,student_id,enrollment_id,billing_cycle_id,policy_version_id,tariff_snapshot_uzs,base_pro_rata_charge_uzs,approved_discount_uzs,credit_note_adjustments_uzs,effective_net_charge_uzs,allocated_paid_uzs,remaining_debt_uzs,billed_lessons,status,due_date,version) VALUES($1,$2,'INV-MANAGER-N',$3,$4,$5,$6,500000,500000,0,0,500000,0,500000,12,'ISSUED_OPEN','2026-11-05',1)`,[invoice,C.centerId,C.studentId,enrollment,cycle,C.billingPolicyId]);
await e.apiPoolA.query(`INSERT INTO cash_shifts(id,center_id,shift_date,opened_by_admin_id,opening_cash_uzs,expected_closing_cash_uzs,status,version) VALUES($1,$2,'2026-11-05',$3,0,0,'OPEN',1)`,[shift,C.centerId,C.adminId]);
const payment=crypto.randomUUID();
await e.apiPoolA.query(`INSERT INTO payments(id,center_id,student_id,cash_shift_id,amount_uzs,currency,payment_method,recorded_by_admin_id,idempotency_key,request_hash,paid_at,recorded_at) VALUES($1,$2,$3,$4,100000,'UZS','CASH',$5,$6,$7,'2026-11-05T06:00:00Z','2026-11-05T07:00:00Z')`,[payment,C.centerId,C.studentId,shift,C.adminId,crypto.randomUUID(),'a'.repeat(64)]);
await e.apiPoolA.query(`UPDATE cash_shifts SET cash_receipts_uzs=100000, expected_closing_cash_uzs=100000 WHERE id=$1`,[shift]);
const config=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
app=await createApiApplication(config);const clock=app.get(ClockService);clock.setTestNow(new Date('2026-11-05T07:00:00Z'));await app.listen(0,'127.0.0.1');const root=`http://127.0.0.1:${app.getHttpServer().address().port}`;
const call=async(path,body,token,key)=>{const r=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token,'Idempotency-Key':key||crypto.randomUUID()}:{} )},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
const login=async()=>{const r=await call('/api/v1/auth/login',{username:'director.demo',password});if(r.status!==200)throw Error('login '+JSON.stringify(r));return r.body.access_token};let token=await login();
const read=await fetch(root+'/api/v1/cash-shifts/'+shift,{headers:{Authorization:'Bearer '+token}});const summary=await read.json();
const close=await call('/api/v1/cash-shifts/'+shift+'/close',{expected_version:1,counted_closing_cash_uzs:'100000'},token);
const ledger=await e.apiPoolA.query('SELECT count(*)::int AS n FROM ledger_entries');
const obs={missing_ledger:{ledger_rows:ledger.rows[0].n,get_http:read.status,projection_drift:summary.projection_drift_detected,close_http:close.status,closed_status:close.body.status}};
// Reconstruct a legitimate predecessor state: S10 allowed repeated partial payments to leave multiple ACTIVE promises.
await e.migratorPoolA.query('DROP INDEX idx_promises_active_invoice');
for(let n=0;n<2;n++)await e.apiPoolA.query(`INSERT INTO promises_to_pay(id,center_id,student_id,invoice_id,trigger_payment_id,promised_amount_uzs,promise_date,status) VALUES($1,$2,$3,$4,$5,400000,'2026-11-10','ACTIVE')`,[crypto.randomUUID(),C.centerId,C.studentId,invoice,payment]);
const fs=require('node:fs');const sql=fs.readFileSync('apps/api/prisma/migrations/20261105000700_s11_cash_shifts_expenses_promises_reconciliation/migration.sql','utf8');
try{await e.migratorPoolA.query(sql);const p=await e.apiPoolA.query('SELECT status,version,superseded_by_promise_id IS NOT NULL AS has_successor FROM promises_to_pay ORDER BY status');obs.predecessor_duplicate_promises_upgrade={success:true,promises:p.rows};}catch(err){obs.predecessor_duplicate_promises_upgrade={code:err.code,message:err.message};}
const lesson=crypto.randomUUID();
await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,'2026-11-04','2026-11-04T04:00:00Z','2026-11-04T05:30:00Z','SCHEDULED',$4,$4)`,[lesson,C.centerId,C.groupId,C.teacherId]);
const extraStudents=[];
for(let i=0;i<2;i++){const sid=crypto.randomUUID();extraStudents.push(sid);await e.apiPoolA.query(`INSERT INTO students(id,center_id,student_code,full_name,normalized_name,status) VALUES($1,$2,$3,'Counter Student','counter student','ACTIVE')`,[sid,C.centerId,'COUNTER-'+i]);await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-11-01')`,[crypto.randomUUID(),C.centerId,sid,C.groupId]);}
const tl=await call('/api/v1/auth/login',{username:'teacher.demo',password});
const teach=tl.body.access_token;
const draft=await fetch(root+'/api/v1/lessons/'+lesson+'/attendance',{headers:{Authorization:'Bearer '+teach}});const draftbody=await draft.json();
const submit=await call('/api/v1/lessons/'+lesson+'/attendance/submit',{client_operation_uuid:crypto.randomUUID(),expected_version:1,source_channel:'TEACHER_WEB',records:[C.studentId,...extraStudents].map(id=>({student_id:id,status:'PRESENT'}))},teach);
const excel=await call('/api/v1/lessons/'+lesson+'/attendance/excel-import',{client_operation_uuid:crypto.randomUUID(),expected_version:1,records:[{student_id:C.studentId,status:'ABSENT'}]},token);
const override=await call('/api/v1/lessons/'+lesson+'/attendance/override',{client_operation_uuid:crypto.randomUUID(),expected_version:submit.body.new_version,override_reason:'Manager synthetic correction',records:[{student_id:C.studentId,status:'ABSENT'}]},token);
const secondOverride=await call('/api/v1/lessons/'+lesson+'/attendance/override',{client_operation_uuid:crypto.randomUUID(),expected_version:override.body.new_version,override_reason:'Second different student correction',records:[{student_id:extraStudents[0],status:'ABSENT'}]},token);
const reread=await fetch(root+'/api/v1/lessons/'+lesson+'/attendance',{headers:{Authorization:'Bearer '+token}});const rereadBody=await reread.json();
const thirdOverride=await call('/api/v1/lessons/'+lesson+'/attendance/override',{client_operation_uuid:crypto.randomUUID(),expected_version:secondOverride.body.new_version,override_reason:'Third different student correction',records:[{student_id:extraStudents[1],status:'ABSENT'}]},token);
obs.version_chain={first_http:override.status,first_returned:override.body.new_version,second_http:secondOverride.status,second_returned:secondOverride.body.new_version,get_current_version:rereadBody.current_version,third_http:thirdOverride.status,third_error:thirdOverride.body.error_code};
const counts=await e.apiPoolA.query('SELECT count(*)::int AS n FROM attendance_records WHERE lesson_id=$1',[lesson]);
obs.attendance={draft_http:draft.status,draft:draftbody,submit,excel,override,record_count:counts.rows[0].n};
console.log('Q_MANAGER_BOUNDARIES '+JSON.stringify(obs));
}finally{if(app)await app.close();await e.cleanup()}})().catch(e=>{console.error({probe_error:e.message,code:e.code});process.exitCode=1});
