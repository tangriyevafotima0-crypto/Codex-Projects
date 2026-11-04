// Manager-only probes: fresh ephemeral eduerp_test_* DB, synthetic credentials, no production effects.
const crypto=require('node:crypto');
const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C,SYNTHETIC_TEST_ONLY_PASSWORD:password,SYNTHETIC_TEACHER_SCRYPT_HASH:hash}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {createApiApplication}=require('./eduerp-v2/apps/api/dist/src/application');
const {loadApiEnv}=require('./eduerp-v2/apps/api/dist/src/config/env');
const {ClockService}=require('./eduerp-v2/apps/api/dist/src/auth/clock.service');
(async()=>{
 const e=await createEphemeralTestDbEnv();let app;const out={};
 try{
  await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
  const sub=crypto.randomUUID(),lesson=crypto.randomUUID(),enr=crypto.randomUUID();
  await e.apiPoolA.query(`INSERT INTO staff_users(id,center_id,role,full_name,login_username,password_hash,must_change_password,status) VALUES($1,$2,'TEACHER','Probe Substitute','probe.sub',$3,FALSE,'ACTIVE')`,[sub,C.centerId,hash]);
  await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-11-01')`,[enr,C.centerId,C.studentId,C.groupId]);
  await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,'2026-11-04','2026-11-04T04:00:00Z','2026-11-04T05:30:00Z','SCHEDULED',$4,$5)`,[lesson,C.centerId,C.groupId,C.teacherId,sub]);
  await e.apiPoolA.query(`INSERT INTO substitute_assignments(id,center_id,lesson_id,original_teacher_id,substitute_teacher_id,assigned_by_admin_id,reason,status,pay_share_policy_snapshot) VALUES($1,$2,$3,$4,$5,$6,'Probe assignment','ACTIVE','PER_LESSON_SUBSTITUTE')`,[crypto.randomUUID(),C.centerId,lesson,C.teacherId,sub,C.directorId]);
  const config=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
  app=await createApiApplication(config);const clock=app.get(ClockService);clock.setTestNow(new Date('2026-11-04T06:00:00Z'));await app.listen(0,'127.0.0.1');const root=`http://127.0.0.1:${app.getHttpServer().address().port}`;
  const call=async(method,path,body,token,key)=>{const res=await fetch(root+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};};
  const director=await call('POST','/api/v1/auth/login',{username:'director.demo',password});const substitute=await call('POST','/api/v1/auth/login',{username:'probe.sub',password});
  out.director_login=director.status;out.substitute_login=substitute.status;
  const key=crypto.randomUUID(),body={expected_version:1,grades:[{student_id:C.studentId,enrollment_id:enr,score:88}]};
  const grade=await call('POST',`/api/v1/lessons/${lesson}/grades`,body,substitute.body.access_token,key);out.initial_grade=grade.status;
  const revoke=await call('POST',`/api/v1/lessons/${lesson}/substitute/revoke`,{reason:'Revoke test assignment',expected_version:grade.body.version},director.body.access_token,crypto.randomUUID());out.revoke=revoke.status;
  const replay=await call('POST',`/api/v1/lessons/${lesson}/grades`,body,substitute.body.access_token,key);out.revoked_same_key_grade_replay=replay.status;
  const fresh=await call('POST',`/api/v1/lessons/${lesson}/grades`,{...body,expected_version:revoke.body.lesson_version},substitute.body.access_token,crypto.randomUUID());out.revoked_new_key_grade=fresh.status;
  const price=await call('PATCH',`/api/v1/courses/${C.courseId}/price`,{group_id:C.groupId,new_fee_uzs:'650000',effective_from:'2026-11-10',reason:'Probe future group fee',expected_version:1},director.body.access_token,crypto.randomUUID());out.future_group_price_update=price.status;
  clock.advanceMs(7*86400*1000);
  const relog=await call('POST','/api/v1/auth/login',{username:'director.demo',password});
  const groups=await call('GET','/api/v1/groups',null,relog.body.access_token);out.future_group_list_status=groups.status;
  const group=groups.body.items?.find(x=>x.id===C.groupId||x.group_id===C.groupId);out.group_fee_after_effective_date=group?.current_fee_uzs;out.expected_group_fee='650000';
  console.log('S07_SEMANTIC_PROBE_RESULT '+JSON.stringify(out));
  const assert=require('node:assert/strict');
  assert.equal(out.initial_grade,200);assert.equal(out.revoke,200);
  assert.equal(out.revoked_same_key_grade_replay,403);
  assert.equal(out.revoked_new_key_grade,403);
  assert.equal(out.group_fee_after_effective_date,'650000');
 }finally{if(app)await app.close();await e.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
