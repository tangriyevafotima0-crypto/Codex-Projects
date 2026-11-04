const {createEphemeralTestDbEnv}=require('./eduerp-v2/apps/api/dist/test/database/harness');
const {executeSyntheticSeed,SYNTHETIC_DEMO_CENTER_A:C,SYNTHETIC_TEST_ONLY_PASSWORD:password}=require('./eduerp-v2/apps/api/dist/src/database/seed-contract');
const {createApiApplication}=require('./eduerp-v2/apps/api/dist/src/application');
const {loadApiEnv}=require('./eduerp-v2/apps/api/dist/src/config/env');
const crypto=require('node:crypto');
(async()=>{
 const e=await createEphemeralTestDbEnv();let app;const result={};
 try{
  await executeSyntheticSeed(e.apiPoolA,C,{NODE_ENV:'test',BOT_OUTBOUND_ENABLED:'false'});
  const config=loadApiEnv({NODE_ENV:'test',LOG_LEVEL:'error',API_HOST:'127.0.0.1',API_PORT:'3000',CENTER_ID:C.centerId,CENTER_SLUG:C.centerSlug,CENTER_TIMEZONE:'Asia/Tashkent',LICENSE_MODE:'ACTIVE',DATABASE_URL:e.apiRuntimeCenterAUrl,JWT_ACCESS_SECRET:'TEST_ONLY_ACCESS_123456789012345678901',JWT_REFRESH_SECRET:'TEST_ONLY_REFRESH_12345678901234567890',INTERNAL_BOT_HMAC_SECRET:'TEST_ONLY_HMAC_12345678901234567890123',TELEGRAM_WEBHOOK_SECRET:'TEST_ONLY_WEBHOOK_1234567890'});
  app=await createApiApplication(config);await app.listen(0,'127.0.0.1');const url=`http://127.0.0.1:${app.getHttpServer().address().port}/api/v1/auth/login`;
  const call=async(key,pwd)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({username:'director.demo',password:pwd})});return {status:r.status,body:await r.json()};};
  const key=crypto.randomUUID(),good=await call(key,password);const replay=await call(key,'WRONG_PASSWORD_1234567');
  result.good_login_status=good.status;result.wrong_password_same_key_status=replay.status;result.wrong_password_receives_same_access_token=Boolean(good.body.access_token)&&good.body.access_token===replay.body.access_token;
  const log=await e.apiPoolA.query(`SELECT response_payload_json FROM client_operation_logs WHERE operation_type='LOGIN_STAFF'`);
  result.raw_refresh_persisted_in_idempotency_log=log.rows.some(r=>JSON.stringify(r.response_payload_json).includes(good.body.refresh_token));
  const t=Date.now();const bad=await call(crypto.randomUUID(),'WRONG_PASSWORD_1234567');result.fresh_bad_password_status=bad.status;result.fresh_bad_password_ms=Date.now()-t;
  result.failed_login_count=(await e.apiPoolA.query(`SELECT failed_login_count FROM staff_users WHERE id=$1`,[C.directorId])).rows[0].failed_login_count;
  console.log('G_SECURITY_PROBE_RESULT '+JSON.stringify(result));
 }finally{if(app)await app.close();await e.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
