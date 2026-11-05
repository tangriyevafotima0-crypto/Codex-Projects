const assert = require('node:assert/strict');
const {WorkerRuntimeSkeleton} = require('./eduerp-v2/apps/worker/dist/src/main');
const {OutboxWorker,SyntheticNotificationTransportAdapter} = require('./eduerp-v2/apps/worker/dist/src/outbox.worker');
const config={nodeEnv:'production',logLevel:'error',workerId:'probe-worker',centerId:'11111111-1111-4111-8111-111111111111',centerSlug:'probe-center',centerTimezone:'Asia/Tashkent',licenseMode:'ACTIVE',databaseUrl:'postgresql://test:test@127.0.0.1/test',pollIntervalMs:50,shutdownTimeoutMs:100,botOutboundEnabled:true};
(async()=>{
const logs=[]; const db={close:async()=>{}};const rt=new WorkerRuntimeSkeleton(config,e=>logs.push(e),db);let polls=0;rt.executePollCycle=async()=>{polls++};rt.start();await new Promise(r=>setTimeout(r,180));await rt.stop('TEST');
const out=new OutboxWorker(config,db);
const syntheticDefault=out.transportAdapter instanceof SyntheticNotificationTransportAdapter;
const result=await out.transportAdapter.sendNotification({centerId:config.centerId,outboxEventId:'event',eventName:'PromiseDue',deliveryId:'delivery',recipientType:'ADMIN',recipientId:'admin',telegramChatId:null,leaseToken:1n,attemptNumber:1,payload:{}});
console.log('R_MANAGER_RUNTIME_OBSERVATIONS '+JSON.stringify({timer_poll_calls:polls,heartbeat_count:logs.filter(l=>l.event==='worker_idle_heartbeat').length,production_default_is_synthetic:syntheticDefault,default_transport_outcome:result.status,fake_message_id:result.telegramMessageId.toString()}));
assert.equal(polls,0);assert.equal(syntheticDefault,true);assert.equal(result.status,'API_ACCEPTED');
})().catch(e=>{console.error(e);process.exitCode=1});
