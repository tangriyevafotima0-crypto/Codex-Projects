// Synthetic, ephemeral, guarded test databases only. Observations, not acceptance assertions.
const crypto=require('node:crypto');
const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C,SYNTHETIC_TEST_ONLY_PASSWORD:password}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {createApiApplication}=require('./eduerp-v2/apps/api/dist/src/application');
const {loadApiEnv}=require('./eduerp-v2/apps/api/dist/src/config/env');
const {ClockService}=require('./eduerp-v2/apps/api/dist/src/auth/clock.service');
(async()=>{const e=await createEphemeralTestDbEnv();let app;try{
 await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
 const legacy=await e.apiPoolA.query('SELECT policy_confirmation_status,first_partial_charge_mode FROM billing_policy_versions WHERE id=$1',[C.billingPolicyId]);
 for(const month of ['10','11'])for(const day of ['02','03','04']){const date=`2026-${month}-${day}`;await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,$4::date,$5::timestamptz,$6::timestamptz,'SCHEDULED',$7,$7)`,[crypto.randomUUID(),C.centerId,C.groupId,date,date+'T04:00:00Z',date+'T05:00:00Z',C.teacherId]);}
 const config=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
 app=await createApiApplication(config);app.get(ClockService).setTestNow(new Date('2026-11-04T09:00:00Z'));await app.listen(0,'127.0.0.1');const root=`http://127.0.0.1:${app.getHttpServer().address().port}`;
 const call=async(path,body,token)=>{const r=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token,'Idempotency-Key':crypto.randomUUID()}:{} )},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
 const login=await call('/api/v1/auth/login',{username:'director.demo',password});const token=login.body.access_token;
 const issue=async(status,enrolled,month)=>{const student=crypto.randomUUID(),enrollment=crypto.randomUUID();await e.apiPoolA.query(`INSERT INTO students(id,center_id,student_code,full_name,normalized_name,status) VALUES($1,$2,$3,'Probe Student','probe student','ACTIVE')`,[student,C.centerId,'PROBE-'+student.slice(0,8)]);await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,$5,$6::date)`,[enrollment,C.centerId,student,C.groupId,status,enrolled]);const r=await call('/api/v1/billing/cycles/invoice',{enrollment_id:enrollment,cycle_type:'CALENDAR_MONTH',cycle_key:`CAL:2026-${month}`,period_start_date:`2026-${month}-01`,apply_available_credit_notes:false},token);const counts=await e.apiPoolA.query(`SELECT count(*)::int AS count,COALESCE(sum(remaining_debt_uzs),0)::text AS debt FROM invoices WHERE enrollment_id=$1`,[enrollment]);return{status:r.status,error:r.body.error?.code||r.body.error_code,invoice_count:counts.rows[0].count,debt:counts.rows[0].debt}};
 const out={legacy_policy:legacy.rows[0],trial_without_attendance:await issue('TRIAL','2026-10-01','10'),active_period_before_enrollment:await issue('ACTIVE','2026-11-12','10')};

 const confirmed=await call('/api/v1/billing/policies',{billing_mode:'CALENDAR_PRO_RATA',first_partial_charge_mode:'PRORATE_REMAINING_LESSONS',policy_confirmation_status:'CONFIRMED',effective_from_date:'2026-01-01'},token);
 out.explicit_policy_status=confirmed.status;
 out.confirmed_trial=await issue('TRIAL','2026-10-01','10');
 out.confirmed_before_enrollment=await issue('ACTIVE','2026-11-12','10');
 out.confirmed_positive=await issue('ACTIVE','2026-10-01','10');
 const pkgPolicy=await call('/api/v1/billing/policies',{billing_mode:'LESSON_PACKAGE_12',first_partial_charge_mode:'FULL_CYCLE',rolling_month_end_mode:'CONTINUE_FROM_CLAMPED_DAY',package_cancel_mode:'PRESERVE_BALANCE',policy_confirmation_status:'CONFIRMED',effective_from_date:'2026-01-01'},token);out.package_policy_status=pkgPolicy.status;
 await e.apiPoolA.query(`UPDATE course_groups SET billing_mode='LESSON_PACKAGE_12',lessons_per_cycle=2 WHERE id=$1`,[C.groupId]);
 const enr=crypto.randomUUID();await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-10-01')`,[enr,C.centerId,C.studentId,C.groupId]);
 const attended=await e.apiPoolA.query(`SELECT id FROM lesson_occurrences WHERE group_id=$1 AND lesson_date IN ('2026-10-02','2026-10-03') ORDER BY lesson_date`,[C.groupId]);
 for(const row of attended.rows)await e.apiPoolA.query(`INSERT INTO attendance_records(id,center_id,lesson_id,student_id,enrollment_id,status,source_channel,recorded_by_staff_id,client_operation_uuid) VALUES($1,$2,$3,$4,$5,'PRESENT','TEACHER_WEB',$6,$7)`,[crypto.randomUUID(),C.centerId,row.id,C.studentId,enr,C.teacherId,crypto.randomUUID()]);
 const pkg=async(seq)=>call('/api/v1/billing/cycles/invoice',{enrollment_id:enr,cycle_type:'LESSON_PACKAGE_12',cycle_key:'PKG:'+seq,period_start_date:'2026-10-01',apply_available_credit_notes:false},token);
 const p1=await pkg(1);out.package_first_status=p1.status;
 const b1=await e.apiPoolA.query('SELECT package_lessons_remaining FROM enrollments WHERE id=$1',[enr]);out.package_first_remaining=b1.rows[0].package_lessons_remaining;
 await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,'2026-10-01','2026-10-01T04:00:00Z','2026-10-01T05:00:00Z','SCHEDULED',$4,$4)`,[crypto.randomUUID(),C.centerId,C.groupId,C.teacherId]);
 const p2=await pkg(2);out.package_second_status=p2.status;
 const b2=await e.apiPoolA.query('SELECT package_lessons_remaining FROM enrollments WHERE id=$1',[enr]);out.package_second_remaining_after_backdated_insert=b2.rows[0].package_lessons_remaining;out.expected_package_second_remaining=2;
 console.log('S08_L_BOUNDARY_PROBE '+JSON.stringify(out));

 }finally{if(app)await app.close();await e.cleanup()}})().catch(e=>{console.error({probe_error:e.message,code:e.code});process.exitCode=1});
