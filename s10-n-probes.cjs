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
const config=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
app=await createApiApplication(config);const clock=app.get(ClockService);clock.setTestNow(new Date('2026-11-05T07:00:00Z'));await app.listen(0,'127.0.0.1');const root=`http://127.0.0.1:${app.getHttpServer().address().port}`;
const call=async(path,body,token,key)=>{const r=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token,'Idempotency-Key':key||crypto.randomUUID()}:{} )},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
const login=async()=>{const r=await call('/api/v1/auth/login',{username:'director.demo',password});if(r.status!==200)throw Error('login '+JSON.stringify(r));return r.body.access_token};let token=await login();
const key=crypto.randomUUID(),body={student_id:C.studentId,cash_shift_id:shift,amount_uzs:'300000',currency:'UZS',payment_method:'CASH',target_invoice_ids:[invoice],promise_date:'2026-11-05'};
const first=await call('/api/v1/payments',body,token,key);const sameDay=await call('/api/v1/payments',body,token,key);
clock.setTestNow(new Date('2026-11-06T07:00:00Z'));token=await login();const nextDay=await call('/api/v1/payments',body,token,key);
const rows=await e.apiPoolA.query('SELECT count(*)::int AS payments FROM payments WHERE student_id=$1',[C.studentId]);
console.log('N_MANAGER_BOUNDARIES '+JSON.stringify({first,sameDay,nextDay,payment_count:rows.rows[0].payments}));
}finally{if(app)await app.close();await e.cleanup()}})().catch(e=>{console.error({probe_error:e.message,code:e.code});process.exitCode=1});
