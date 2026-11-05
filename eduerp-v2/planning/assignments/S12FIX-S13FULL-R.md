# S12FIX-S13FULL-R — qolgan davomat tuzatishlari va to‘liq worker/scheduler

Bitta katta paket: avval Q reviewdagi qolgan topilmalarni va 11.01–12.05 qabulini yoping, keyin13.01–13.05ni to‘liq candidate sifatida bajaring. Oraliq manager javobini kutmang. Bu yangi combined draft ruxsati, predecessor/global approvalni o‘zgartirish ruxsati emas. Exact holat va source tarkibi rootTASK_INPUTda. Yakun IN_REVIEW, S14/liveTelegram/production yo‘q.

## A. Kirish va saqlash

START_HERE/TASK_INPUT/VERIFY_INPUT; AGENTS, OWNER_DECISIONS01–05, USER_WORKING_PREFERENCES, ARGON_LEARNING, joriy Q manager review/evidence, S11/S12 handoff va canonical S13stage/promptlarni o‘qing. Input — old main + to‘liq Q candidate + reviewda sanalgan manager assists, old ZIP talab qilinmaydi.

Manager assistlarni saqlang: attendance actor-spoof check, upgrade harness haqiqiy URL/path va Prisma migrate resolve/deploy/history test, contradictory header/body400 fixture, missing request_hash fixtures, immutable billing policy yaratish uchun haqiqiy Director API. Bularni eski input yoki o‘ylab topilgan helperga qaytarmang. Auth/APP_GUARD/readiness/DBsingleton/Clock/DATE/Ntemporalreplay/lockfile/immutableledger/durablepackageownership va G1–G9 saqlansin. Global manager registrlar read-only.

## B. R01 — S12 lesson aggregate versiyasi

Mustaqil real probe3student bilan xatoni ko‘rsatdi: initial submitv1; studentA override→responsev2; studentB override expected2→responsev3, lekin GET current_version2; studentC returned3 bilan yuborsa409. MAX(per-record version) lessonning transaction versiyasi emas. Faqat bitta studentni ko‘p marta yangilash testi buni tutmaydi.

Bitta authoritative persisted lesson-attendance aggregate revision yarating yoki aniq ekvivalent model tanlang. Alohida immutable per-record AttendanceRevision versiyasi o‘sha studentda contiguous bo‘lib qolsin, tegilmagan studentning source/actor/version/revisionsiga tegmang. GET current_version, submit/override new_version, conflict server_version, offline ack va operationlog response shu persisted aggregate qiymatga mos bo‘lsin. Lesson schedule/grade umumiy versionini o‘ylamay qayta ishlatmang; attendance aggregate va boshqa yozishlar o‘rtasidagi relation aniq ADRda. S11 acceptance bo‘lsa migration01–07 endi approved history: ularni tahrirlamang. Yangi column/helper kerak bo‘lsa additive keyingi migration, grants/Prisma/validator/fresh+upgrade tests moslansin.

Eski committed operationlog va revisionlar append-only: yangi aggregatecounter backfilli mavjud history/log/response bilan izchil bo‘lsin. Eski key replay o‘sha operatsiyaning tarixiy javobini qaytarishi mumkin; boshqa keyingi commitlar bo‘lsa replaydagi oldversionni yangi currentversionga qayta yozmang. Fresh muvaffaqiyatli command qaytargan versiya o‘sha commitda persisted bo‘lishi shart. Idempotent replay versiyani oshirmaydi; failed transaction aggregatecounter ham rollback. Parallel equalexpected two Adminwrites (turli studentlarda ham) faqat bittasi commit, boshqasi409.3student ketma-ket A→B→C returnedversion bilan davom etadi, harGET response bilan mos, untouchedhistory saqlanadi. Eski Excel stale response haqiqiy current value, current+1 degan fakeversion yo‘q. Operationlog va outboxaggregateordering bu o‘zgarish bilan izchil bo‘lsin.

## C. R02–R03 — Q runtime closure va evidence

Q reviewdagi qolgan actual test failures/fixtures yopilsin; manager tuzatgan offline IdempotencyConflictError/OptimisticVersionConflictError per-operation CONFLICT_409 mapping va substitute fixture must_change_password=false saqlansin. Bu global password-change himoyasini o‘chirish emas; testdagi tayyor xodim holatini to‘g‘ri sozlash. aniq ro‘yxat managerreviewda. Test assertionni yumshatib yoki guard/immutablegrantni o‘chirib PASS qilmang. G9 beforehookdan barcha mustaqil substantiveassertionsga yetsin. Teacher/substitute/revoke replay, scope, READ_ONLY, draft nowrites, staleExcel, Adminreason/partialoverride, trial1/2distinctattendance, rollback/no-PII va SQLiteack exact tests. G8canonicalcashmath/ledgercompleteness/outbox/close-vs-payment-expense-reversal saqlansin.

S11/S12 approvalini o‘zingiz ko‘tarmang. Fullcleanbuilddan keyingi realG1–G9 va Docker smoke talab; offlineNOT_RUN. Old reportni keyin run qilingandek qayta yozmang, yangi docs/verification/S12-R.md closure dalillarini ajratsin. Manager reference probe observational, processsuccess semantikacceptanceemas.

## D. 13.01 — Outbox lease/fencing/retry/DLQ

Fayllar: apps/worker/src/{database.ts,outbox.worker.ts,consumers/*,main.ts}, zarur shared typed contract/helperlar. Mavjud Nodeworker lifecycle va SIGTERMtest saqlansin, barcha ish stub/no-oploop bo‘lib qolmasin. Eng muhim unit emas, realPG integration.

Worker faqat o‘z centerDB va workerrole bilan ishlaydi. `FOR UPDATE SKIP LOCKED`/equivalent atomic claim, lease_token monotonic fencing, lease expiry va next_attempt_at, boundedbatch/retry+jitter/backoff. Har transition currentfencingtoken/owner/statusni WHERE’da tekshirsin; eskileaseholder ack/requeue/deadletter qilolmasin. Aggregate predecessor version gate: biraggregate ichida ordering, unrelatedaggregate poison sabab to‘xtamasin. Claimed-but-unfinished job processcrashdan keyin leaseexpiry orqali qaytadi.

Internal DB consumer effect+OutboxConsumerReceipt bitta transaction. Idempotent domain key, consumer_name+event identity va fencing receipts; receipt yozilib effect yo‘q yoki teskarisi bo‘lmasin. Existingimmutableeventpayload/status lifecycle va append-only receipt/audit saqlansin. Poison event boundedattemptdan keyin DLQ, safereason/errorclass; PII/token/phone rawstack/log yo‘q. Manual replay administrativ seam bo‘lsa role/reason/audit va no duplicateeffect; ruxsatsiz publicDLQ endpoint yo‘q.

Externaldelivery semantics rost bo‘lsin: tashqi senddan keyin crash yuz bersa duplicate ehtimoli bor; DBreceipt exactly-once networkdeliveryni kafolatlamaydi. Fake adapter bilan before-send/after-send/beforeack/crash windowsni tekshiring, ambiguity/possible_duplicate observability. Real Telegram/HTTP send defaulto‘chiq, BOT_OUTBOUND_ENABLED=false; restore holati failclosed. No transport yoki unresolved recipient policy bo‘lsa DELIVERED emas pending/blocked. Adapter interface va synthetic fake sourcebo‘lsin, S14tayyor deb claim qilmang.

## E. 13.02 — Markaz local09:00 promise eslatmasi

apps/worker/src/reminders.worker.ts. CenterIANA timezone, actual persistedpromise/debt/balance eligibility; to‘lov, reversal, discount, supersession va FULFILLED/CANCELLED statusni yuborish/intentcommit oldidan qayta o‘qing. Duepromise uchun dedup identity center+promise+localdate+notificationkind.9danoldincreate/sendyo‘q. UTC/centerdateboundary, DSTgap/fold va clockrollback tests.

Worker09:00daofflinebo‘libkeyinqaytsa sameeligiblelocalday ichida boundedcatch-upbirmarta; ko‘pkunlik eski eslatmalarni birdan spamqilmang. Catch-upconfiguration explicitversioned/policy va cutoff, unsupported variantgated. To‘langan qarz uchun previouslyqueuedintent stale bo‘lsa cancelled/suppressed receipt, jo‘natildi deganfalseclaimyo‘q. Schedulequery faqat promiseexists deganiyetmaydi. Snapshotlastremainingvalue stale bo‘lmasin.

Guardian/Admin recipient channel vakolati OWNER/OPEN_CHANNEL bilan izchil. Tasdiqlanmagan channelpermissionga silentglobaldefault yo‘q; recipientintent/blockedpolicystate test. Realcontact routing/logPII va externalbot S14scope. Tashqi tarmoqda «hechqachon ikki xabar bo‘lmaydi» degan kafolatni bermang; crashdan keyingi noaniqlikni ochiq model qiling.

## F. 13.03 — Teacher ping va Admin escalation

apps/worker/src/teacher-ping.worker.ts. Lessonstartdan20minute keyin canonical submittedattendance bo‘lmasa aynibitta pingintent; dars tugaganda stillunsubmitted Adminescalation once. DraftdefaultPRESENTsubmit emas. Teacher role/primary/substitute vakolati aynan lesson uchun processingtime’dajonli rezolyutsiya qilinsin, oldsubstituterevoked/reassigned bo‘lsa oldteacherga pingyo‘q.

CANCELLED_BY_CENTER/RESCHEDULED lesson suppress, reschedulednewoccurrence o‘zidentity; attendancecommitted bo‘lsa queuedping yuborilmaydi.20minutdanqisqadars, endboundary, longoffline restart va simultaneousworkers test. Dedupkeys lesson+kind+intendedrecipient/versionpolicy, receiverchange oldintentni yangilash/suppress auditable; birlessonning primaryvaoldsubstitutega ikkitaactiveping ketmasin. RealTelegramyo‘q, typedoutboxintent+fakeadapterruntimeproof.

## G. 13.04 — Billing/shift/trial follow-up va catch-up

apps/worker/src/schedules.worker.ts. Stablejobidentity center+jobkind+canonicalcycle/localwindow; ikkiworker/rerun/restartbitta domaineffect. Lease/fencing/transactionconsumerreceipt orqali exact financial idempotency. Existing billing workerentrypoint va eligibility/policy/historicaltariff/Trial gates ishlatilsin, invoiceengineformulalarini ikkinchi martayozmang. Domaincore reuse uchun package/interface extraction kerakbo‘lsa scopedADR+allregressions; directprivateAPIimport yoki duplicatefinancialimplementationtutashmasin.

Billing faqat explicitconfirmed/effectivedate policy va ACTIVEeligibleenrollment; TRIALdastlabmanualqarzga o‘tmaydi. Disabled/READ_ONLY/unverifiedlicense centerda financialmutationyo‘q. Missedcyclecatch-up oldperiodni duplicatecharge qilmaydi, durablepackageownership saqlanadi. Unknowncatch-uppolicy pending/failclosed; hammaeski davrlarga avtomatik qarzyozish yo‘q.

Shift scheduler smenani sanalganpulni o‘ylab topib avtomatikCLOSED qilmasin. Closingreminder/unfinishedshiftflag va validatedexistingclosecommand chegarasini saqlang; counted/reasonDirector/Adminflow S11da. Closedhistorymutableemas.

Trialno-showfollow-up centerpolicyga mos explicitconfiguration: secondscheduledabsence yoki other confirmedvariant; D14ning buqismi oldbilling/freezeownerqarori bilan avtomatiktasdiqlanmagan. Unconfigured variantblocked; syntheticconfirmedpolicyfixturepositive. Follow-upAdminintent — o‘zicha invoice/debt/payroll yoki attendancePRESENT emas. Restart/catch-up/workerclock boundaries, duplicates lessoncountsdan emasdurableevent/jobidentitydan dedup.

## H. 13.05 — Real evidence, integration gate va output

npmrun test:worker:integration (yoki izchilnom) va GateG10 actualPostgreSQL. Worker dependency/config/env canonicalkeys, .env.example/Compose/CI va health/processshutdown mos. RuntimeAPI/worker/migratorroles ajratilsin; workerga superuser/immutableUPDATEgrant bermang. Newinfrahelper tables bo‘lsa canonical46entity bilan adashtirmang; coverage/inventory/schema/grants/readinesschecks izchil. Additivemigration + actualPrisma fresh/populatedupgrade/checksumhistory.

G10matrix:twoworkerclaimsingleeffect; staleleaseackrejected; expiryretry; poisonDLQunrelatedeventcontinues; aggregateorder; internalconsumercrashrollback+receipt; externalfakeambiguousafter-send;09:00+catch-up+paidpromise; supersededcancelled; primary/substituterevoke/reschedule/ping/escalation; financialjobduplicates/policydeny; disabledcenter; restoreBOT_OUTBOUNDfalse; SIGTERMdrain/leasehandling. Assertionsrealrows/statuses/effectcounts, no testname-onlycoverage. Boundedtimeout and controllableclock, no longsleep/testsdeadlock.

Runlockedinstall, Prisma, lint, typecheck, build, unit, G1–G10, Docker availablemuhitda. BajarilmaganNOT_RUN, fakePASS/lock/generatedclient/pycyo‘q. Dependencyneeds exactpackage/lockrefreshflag. Newexports/SQLcolumns actualinterfacehash bilan ARTIFACT_PROOF; previouspackagingauditdiscipline davometsin.

Docs: ADR-013, docs/verification/S12-R.md va S13.md, architectureevents/API/RBAC/dbroles/contracts,13.01..05stepreports, handoffs/S13.md; unresolvedpolicyandS14deliveryseam aniq. Globalmanagerapproval/statusreadonly. Workerinfrastructuretayyordeganclaim realexternaldeliverytayyorligiemas.

Yakun S12FIX_S13FULL_R_SUBMISSION.zip: faqat shuINPUT_MANIFESTdan keyingichanged/newsource+SUBMISSION.json; exacttask/base/candidate/statusIN_REVIEW/files[path,sha256]/deleted_files/actual_tests/not_run/needs_manager_dependency_refresh. ARTIFACT_PROOF.md va manageraudit_submission.py bilan exactdelta/hash/requiredfiles tekshirilsin (rootTASK_INPUTdagi currenttask qoidasiustuvor). Reportarchiveyaratilgandankeyinyozilsin. NoS14/liveTelegram/gateway/production/payroll. Birpaketichidahammasiniyakunlang,approvalmanagerda.

## Qo‘shimcha aniq regressiyalar va artifact dalili

R01 uchun `ATT-IT-11` — uch o‘quvchini ketma-ket turli subsetlarda returned version bilan tuzatish va har GET bilan moslik; `ATT-IT-12` — equal-version turli student parallel correctiondan bitta winner, rollback/replay aggregatecounterga ta’sir qilmasligi. Mavjud G9testlarni o‘chirmang. New migration8 bo‘lsa DB-IT-21 current migration history/fresh-upgrade assertionsni qo‘shimcha migratsiyaga moslang, old valid predecessor data proofni saqlang.

Worker realPG suite: apps/worker/test/worker-integration.test.ts, kamida `WORKER-IT-01` lease/fencing, `WORKER-IT-02` internal effect+receipt rollback/dedup, `WORKER-IT-03` promise09:00/debtpaid/catch-up holatlari uchun mustaqil executable testlar. Qolgan G10matrix ham alohida cases bilan qamralsin; bu3test butun scope o‘rnini bosmaydi. R1/R2 kabi umumiy nom bilan yashirish emas actualcode assertionlari kerak.

ARTIFACT_PROOF.md va manager_reference/audit_submission.py rootTASK_INPUTdagi required_output_files/required_test_declarationsni tekshiradi. Outputning barcha realdelta fayllari va deleted_files metadata bo‘lsin; source yoki test yozilib ZIPdan tushib qolmasin. Report faqat arxivhashlar yakunlangandan keyin. Metadata actual command/result yoki NOT_RUN bo‘lsin, worker integration testfiles borligi runtimePASS degani emas.
