// Read-only assertions and synthetic ephemeral DB only; observational failures are not acceptance.
const crypto=require('node:crypto');
const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C,SYNTHETIC_TEST_ONLY_PASSWORD:password}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {createApiApplication}=require('./eduerp-v2/apps/api/dist/src/application');
const {loadApiEnv}=require('./eduerp-v2/apps/api/dist/src/config/env');
const {ClockService}=require('./eduerp-v2/apps/api/dist/src/auth/clock.service');
const {WorkerDatabase,CanonicalSqlBillingCycleWorkerPort,RemindersWorker,SchedulesWorker}=require('./eduerp-v2/apps/worker/dist/src/main');
const {loadWorkerEnv}=require('./eduerp-v2/apps/worker/dist/src/config/env');
(async()=>{let app,wdb;const e=await createEphemeralTestDbEnv();const obs={};try{
await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
const policy=crypto.randomUUID();
await e.apiPoolA.query(`INSERT INTO billing_policy_versions(id,center_id,version_number,billing_mode,rounding_mode,discount_stacking_mode,freeze_credit_basis,rolling_month_end_mode,package_cancel_mode,refund_debt_mode,first_partial_charge_mode,policy_confirmation_status,effective_from_date) VALUES($1,$2,2,'LESSON_PACKAGE_12','HALF_UP_UZS_INT','UNCONFIGURED','UNCONFIGURED','CONTINUE_FROM_CLAMPED_DAY','PRESERVE_BALANCE','REOPEN_INVOICE_DEBT','UNCONFIGURED','CONFIRMED','2026-01-01')`,[policy,C.centerId]);
await e.apiPoolA.query(`UPDATE course_groups SET billing_mode='LESSON_PACKAGE_12',billing_policy_version_id=$1 WHERE id=$2`,[policy,C.groupId]);
const enrollment=crypto.randomUUID();await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-11-01')`,[enrollment,C.centerId,C.studentId,C.groupId]);
for(let n=1;n<=12;n++){const date=`2026-11-${String(n).padStart(2,'0')}`;await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,$4,$5,$6,'SCHEDULED',$7,$7)`,[crypto.randomUUID(),C.centerId,C.groupId,date,date+'T04:00:00Z',date+'T05:30:00Z',C.teacherId]);}
const wc=loadWorkerEnv({NODE_ENV:'test',LOG_LEVEL:'error',WORKER_ID:'manager-s-probe',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.workerRuntimeCenterAUrl,WORKER_POLL_INTERVAL_MS:'500',WORKER_SHUTDOWN_TIMEOUT_MS:'500',BOT_OUTBOUND_ENABLED:'false'});wdb=new WorkerDatabase(wc);
const cfg=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
app=await createApiApplication(cfg);app.get(ClockService).setTestNow(new Date('2026-11-05T07:00:00Z'));await app.listen(0,'127.0.0.1');const root=`http://127.0.0.1:${app.getHttpServer().address().port}`;
const call=async(path,body,token)=>{const r=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token,'Idempotency-Key':crypto.randomUUID()}:{} )},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
const login=await call('/api/v1/auth/login',{username:'director.demo',password});if(login.status!==200)throw Error('login '+login.status);
const api=await call('/api/v1/billing/cycles/invoice',{enrollment_id:enrollment,cycle_type:'LESSON_PACKAGE_12',cycle_key:'PKG:1',period_start_date:'2026-11-01'},login.body.access_token);
obs.unconfigured_package={api_http:api.status,api_error:api.body.error_code};
try{const port=new CanonicalSqlBillingCycleWorkerPort(wdb,()=>new Date('2026-11-05T07:00:00Z'));const result=await port.issueWorkerInvoiceForCycle({centerId:C.centerId,enrollmentId:enrollment,cycleType:'LESSON_PACKAGE_12',cycleKey:'PKG:1',periodStartDate:'2026-11-01',periodEndDate:null,systemJobName:'manager-s-synthetic-probe'});obs.unconfigured_package.worker_result=result;}catch(err){obs.unconfigured_package.worker_error={code:err.code,message:err.message};}
const rows=await e.apiPoolA.query('SELECT effective_net_charge_uzs::text,remaining_debt_uzs::text FROM invoices WHERE enrollment_id=$1',[enrollment]);obs.unconfigured_package.persisted=rows.rows;
const reminders=new RemindersWorker(wc,wdb);obs.channel_policy=await reminders.resolveEffectiveChannelPolicy();obs.channel_env_configured=Boolean(process.env.PROMISE_REMINDER_CHANNEL_POLICY);
// A per-tick limit must not silently drain all historical rolling periods across repeated current-only polls.
const rollingPolicy=crypto.randomUUID(),rollingGroup=crypto.randomUUID(),rollingEnrollment=crypto.randomUUID();
await e.apiPoolA.query(`INSERT INTO billing_policy_versions(id,center_id,version_number,billing_mode,rounding_mode,discount_stacking_mode,freeze_credit_basis,rolling_month_end_mode,package_cancel_mode,refund_debt_mode,first_partial_charge_mode,policy_confirmation_status,effective_from_date) VALUES($1,$2,3,'ROLLING_MONTH','HALF_UP_UZS_INT','UNCONFIGURED','UNCONFIGURED','CONTINUE_FROM_CLAMPED_DAY','PRESERVE_BALANCE','REOPEN_INVOICE_DEBT','FULL_CYCLE','CONFIRMED','2025-01-01')`,[rollingPolicy,C.centerId]);
await e.apiPoolA.query(`INSERT INTO course_groups(id,center_id,course_id,name,primary_teacher_id,billing_mode,current_fee_uzs,lessons_per_cycle,schedule_days_json,starts_time,duration_minutes,timezone,status,billing_policy_version_id) VALUES($1,$2,$3,'Manager bounded catchup probe',$4,'ROLLING_MONTH',480000,12,'["MON","WED","FRI"]','09:00',90,'Asia/Tashkent','ACTIVE',$5)`,[rollingGroup,C.centerId,C.courseId,C.teacherId,rollingPolicy]);
await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-01-31')`,[rollingEnrollment,C.centerId,C.studentId,rollingGroup]);
const sch=new SchedulesWorker(wc,wdb);obs.current_only_repeated_ticks=[];
for(let n=0;n<3;n++){try {await sch.runBillingCycleCutoffAndCatchUpJob({nowUtc:new Date('2026-11-05T07:00:00Z'),catchUpPolicy:'CURRENT_CYCLE_ONLY'});}catch(err){obs.current_only_repeated_ticks.push({error:err.message});break;}}
obs.current_only_historical_cycles=(await e.apiPoolA.query(`SELECT bc.cycle_key,bc.period_start_date::text,i.remaining_debt_uzs::text FROM billing_cycles bc JOIN invoices i ON i.billing_cycle_id=bc.id WHERE bc.enrollment_id=$1 ORDER BY bc.cycle_seq`,[rollingEnrollment])).rows;
console.log('T_MANAGER_OBSERVATIONS '+JSON.stringify(obs));
}finally{if(app)await app.close();if(wdb)await wdb.close();await e.cleanup();}})().catch(err=>{console.error('T_MANAGER_PROBE_ERROR '+JSON.stringify({code:err.code,message:err.message}));process.exitCode=1});
