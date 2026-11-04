// Manager diagnostic only: destructive operations target fresh harness-created eduerp_test_* DBs.
const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {executeIdempotentOperation}=require('./eduerp-v2/apps/api/dist/src/database/idempotency');
const crypto=require('node:crypto');
(async()=>{
 const e=await createEphemeralTestDbEnv();const result={};
 try{
  await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
  const other=crypto.randomUUID(),enr=crypto.randomUUID(),lesson=crypto.randomUUID();
  await e.apiPoolA.query(`INSERT INTO students(id,center_id,student_code,full_name,normalized_name,status) VALUES($1,$2,'PROBE-2','Probe Two','probe two','ACTIVE')`,[other,C.centerId]);
  await e.apiPoolA.query(`INSERT INTO enrollments(id,center_id,student_id,group_id,status,enrolled_at_date) VALUES($1,$2,$3,$4,'ACTIVE','2026-11-04')`,[enr,C.centerId,other,C.groupId]);
  await e.apiPoolA.query(`INSERT INTO lesson_occurrences(id,center_id,group_id,lesson_date,starts_at_utc,ends_at_utc,status,primary_teacher_snapshot_id,pay_recipient_teacher_id) VALUES($1,$2,$3,'2026-11-04','2026-11-04T04:00:00Z','2026-11-04T05:00:00Z','SCHEDULED',$4,$4)`,[lesson,C.centerId,C.groupId,C.teacherId]);
  try{
   await e.apiPoolA.query(`INSERT INTO attendance_records(id,center_id,lesson_id,student_id,enrollment_id,status,source_channel,recorded_by_staff_id,client_operation_uuid) VALUES($1,$2,$3,$4,$5,'PRESENT','TEACHER_WEB',$6,$7)`,[crypto.randomUUID(),C.centerId,lesson,C.studentId,enr,C.teacherId,crypto.randomUUID()]);
   result.attendance_wrong_student_enrollment='INCORRECTLY_ACCEPTED';
  }catch(x){result.attendance_wrong_student_enrollment=x.code;}
  const key=crypto.randomUUID();
  for(const op of ['PROBE_A','PROBE_B']){
   try{await executeIdempotentOperation(e.apiPoolA,{centerId:C.centerId,actorStaffId:C.directorId,operationType:op,idempotencyKey:key,requestPayload:{a:1},handler:async()=>({statusCode:200,body:{ok:true}})});result['idempotency_'+op]='SUCCESS';}
   catch(x){result['idempotency_'+op]=x.code||x.errorCode||x.name;}
  }
  const d2=crypto.randomUUID();
  await e.apiPoolA.query(`INSERT INTO staff_users(id,center_id,role,full_name,login_username,password_hash,status) VALUES($1,$2,'DIRECTOR','Second Director','probe.director.2','TEST_ONLY_NOT_REAL_HASH','ACTIVE')`,[d2,C.centerId]);
  const a=await e.apiPoolA.connect(),b=await e.apiPoolA.connect();
  try{
   await Promise.all([a.query('BEGIN'),b.query('BEGIN')]);
   await Promise.all([a.query(`UPDATE staff_users SET status='DEACTIVATED' WHERE id=$1`,[C.directorId]),b.query(`UPDATE staff_users SET status='DEACTIVATED' WHERE id=$1`,[d2])]);
   await Promise.all([a.query('COMMIT'),b.query('COMMIT')]);
  }finally{await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK')]);a.release();b.release();}
  result.active_directors_after_concurrent_deactivation=(await e.apiPoolA.query(`SELECT count(*)::int n FROM staff_users WHERE role='DIRECTOR' AND status='ACTIVE'`)).rows[0].n;
  console.log('MANAGER_EXTRA_PROBE_RESULT '+JSON.stringify(result));
 }finally{await e.cleanup();}
})().catch(x=>{console.error(x);process.exitCode=1});
