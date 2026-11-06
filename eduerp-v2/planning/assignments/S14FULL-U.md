# S14FULL-U — to‘liq Telegram integratsiyasi va umumiy notification sozlamalari

Bitta katta paket:14.01–14.05 to‘liq implementatsiya, S13 manager acceptance’dan o‘tgan input ustida. Oraliq manager javobini kutmang. Status IN_REVIEW; global manager registrlar read-only. S15/UI, real Telegram xabar yuborish, gateway, production deploy boshlanmaydi. OWNER-20261106-06 qoidasi shu topshiriqning majburiy kirishi.

## Kirish va doimiy ish joyi
Bu task shu avvalgi doimiy papkaga manager tomonidan joylashtirilgan. Root TASK_INPUT/START_HERE/ARGON_PROMPT/CHECKPOINT_MANAGER_SETUPni o‘qing; VERIFY_INPUT bilan baselinehash. Oldingi Tsubmission/checkpoint archive/ ostida saqlangan; uni yangi baselinega qayta ochmang. Har bosqichda yangi papka ulash talab qilinmaydi.

AGENTS, OWNER_DECISIONS01–06, current S13-T managerreview+JSON, ARGON_LEARNING/preferences, S13handoff, canonicalS14stage/prompts, OpenAPI UC14 va actualauth/config/DTO/SQL source’dan foydalaning. Har helper/constructor/exports haqiqiy imzosini o‘qing, taxminiy wrapper yasamang. Accepted code/migrations01–09 va managerfixlarni saqlang; schema kerak bo‘lsa additive10+. Testda billing/notification policy immutableUPDATE emas actualDirectorcommand yoki yangi validversionfixture.

U01–U07 quyida bir coherent oqim. Chat qisqa; batafsilsource/evidence fayllarda, final250so‘zgacha. Limit oldidan CHECKPOINT+partialsourceartifact; unavailabletest NOT_RUN, fakecomplete/PASS/lock/generatedclient yo‘q.

## U01 /14.01 — invite va native contact orqali guardian bog‘lash
`apps/bot` workspace typedconfig/bootstrap va linking.ts; backend command API uchun `apps/api/src/bot` module/service/controller. Bot DBga bevosita ulanmaydi: center-scoped authenticated Backend Command API. Mavjud APIglobalAPP_GUARD/DatabaseModule/readiness/Clock/DATE/auth/password-change transportlari saqlanadi; bot routes uchun alohida explicit policy, umumiy guardni o‘chirmang.

Guardian invite: authorizedDirector/Admin command scope va objectownership, cryptographicallyrandom singleuse/expiry/revoke, DBda hash; token/queryurl/contactphone rawlogs yo‘q. GuessableID/phone-basedopenlookup yo‘q. Invite center+guardian+intentga bound, expiry serverclock, two simultaneous consumes exactlyone, committed replay deterministic without second binding. Repeatedrequest differentTelegramuser conflictdeny. contact.user_id === update.message.from.id, sender va contact IDs correct int64/string (JSunsafe numberni yo‘qotmang), E164normalization kanonikhelper. Forwardedcontact/foreignnumber/typedtext/expired/wrongcenter/wrongsecret/requestreplay no childdata.

Guardianstudentlist serverdagi activeguardian_studentsdan. Phonechange/unlink/relink eski chat/callback/session/cache/queuedrightsni atomik bekor qiladi, GuardianLinkRevoked outbox izchil. Sameguardianmulti-child/twoGuardianperchild, siblingphone duplicates, twocenters physicallyisolated; stalejobs/newlink race. Guardianweb/studentlogin scopeiga o‘tmaydi.

StaffTelegramlink (DIRECTOR approval va Teacher/Adminnotifications uchun): JWTauthenticatedself-scoped singleuse linking, bodyrole/chatdan vakolat olinmaydi; Directorrole livebackendstaff holatidan. Guardian/staff identitymapping alohida, oldbindingrevocation. Notificationkanali defaultOFF va authorizationpolicy gate saqlanadi. Real TelegramAPI chaqiruvi yo‘q; local webhook fixtures/fakeadapter.

## U02 /14.02 — backend queries va xavfsiz Director callback
Canonical routes `handleTelegramWebhookUpdate`, `verifyGuardianTelegramContact`, `getGuardianBalanceAndAttendanceForBot`, `executeDirectorApprovalCallbackFromBot`ni realimplementatsiya va OAS/RBAC/inventoryga moslang. Bot internalHMAC: signature canonicalmethod/path/rawbody/timestamp+nonce, timing-safecompare, boundedtimestampwindow, durable replay/dedup, per-center secrets. Telegram webhook X-Telegram-Bot-Api-Secret-Token validation va bodybounds/rate limit alohida; ishonchli ingress tekshiruvigacha from.id/contacttrusted emas. StaffJWTni fake staffprincipal bilan chetlab o‘tmang. Internalrequests untrustedX-Forwarded center/role/chat injectionga yopiq.

Guardian query faqat joriy activelylinkedchatga tegishli childrenbalance/attendance; childID callback bodyda almashtirilsa deny, unrelatedsiblingdata yo‘q, phonelinkrevoke darhol ishlar. Teacherdtofinance/phone/lograw taqiqi saqlanadi. Backend owns businessqueries; botreadonlyprojection.

Directorapprove callback opaque signed/singleuse token; action,center,requestID,expectedversion,recipient/principalbinding,expiry. Telegramcallback_data max64bytes shartiga sig‘sin (opaque serverreference ishlatish mumkin). Director identity live staffrole/status/linkdan, confirm channel verified. Admin/Teacher/forgedforwarded/crosscenter/oldrole/expired/revoked/outdatedexpectedversion deny. Repeat validcommittedcallback duplicatefinancialeffect qilmaydi; currentauthorization cache’danoldin. Real S09discount/S10reversal commands reuse, formula/log/ledger/wrappers nusxalanmaydi. Pending monetary policy failclosed; callback trialrefund/D22ni o‘zboshimcha tasdiqlamaydi. Faultafter financialwrite/audit/outbox fullrollback.

## U03 /14.03 — template va worker transport adapter
notifications.ts/delivery.ts: internalreceipt(nonfiscal), absence/late/correction, discountapprovalrequest, reversalalert, shiftdigest, promise reminders va teacherping/escalation typedtemplates. Event→requiredrecipient→minimalpayload→templateversion mapping. O‘zbek text + safeHTML/Markdownescaping, lengths/format, UZS BigIntstring. Batchattendance recipientchildprojection S13da qo‘yilgan: boshqa studentID/status/phone/finance payloadda yo‘q. Correctionnewstatus/statusnone/previous absent history faqat authorizedchild, no stale-revoked recipient.

S13workeroutboxlease/fencing/consumerreceipts/durableattempt/ambiguoussend reuse. Telegramadapter explicitdependencyinjection/config, fakeadapterproductiondefaultemas. Real HTTPimplementation faqat fake localserver orqali test, no actualapi.telegram.org calls/no realtoken. Production BOT_OUTBOUND_ENABLED=false, globalkill-switch, center/event/role/channeldefaultOFF; demo recipient allowlist positivebound. Configuredtrue but missingtoken/policy/link defaultdefer/deny, no fabricatedmessageID. Unknown/unrenderableevent reasoned blocked/deadletter; no silently lostrequirednotification. Internal effectonce va externalatleastonce/no readreceipt guarantee.

429 retry_after parsed/validated/capped,next_attempt_at, nohotloop;403blocked currentmatchinglink updates atomicallyfenced (oldlink403newrelinkblockedbo‘lmasin); networktimeout/sendaftercrashpossibleduplicateobservable. API_ACCEPTED provideraccepted only, READ emas. Per-recipient mixedoutcomes aggregate correct, unrelatedpoison nohead-oflineblock. No need install thirdpartybotsdk iffetch typedminimaladapter enough; newdeps exactmanifest/refreshflag.

## U04 — OWNER-20261106-06: markaz bo‘yicha umumiy sozlamalar
User: “hammasi bo‘lsin ammo standardda o‘chiq ammo umumiy tanlash, o‘zgartirish va boshqaruvi bo‘lsin.” Savol Teacherping/Admineslatmakanallari haqida edi. Veb/In-App, MobilePush, Telegram kanal turlari mavjud bo‘lsin; har markaz boshqaradi, barcha defaultOFF. Bir nechta kanalni birga tanlash, eventkind+recipientrole bo‘yicha optin/disable, markazumumiydisable/kill-switch, version/expectedversion/rbac/audit, activepolicyprovenance/deliverydedup perchannel.

Authoritative sharedbackendconfig (Directoradministration; Admin/Teacher configwrite yangi huquq berilmagan). Existingpromisechannelpolicy/notificationstatuscolumnsni qamrov yo‘qotmasdan migratsiya/readcompatmapping; oldCONFIRMEDbilling notificationon qilmaydi, accepted09history rewrittenemas. Sozlamaningconfirmation/effectivefrom/untilni haractiveconfig bilan izchil qiling. Staffselfunsubscribe mavjud bo‘lsa faqatownscope/centerpermission intersection; centerOFFni userON chetlab o‘tmaydi.

Bitta managementAPI va kelajakS15web/S17mobilega typedcontract/handoff. Shu bosqichda S15frontend/S17nativepushUI yoki realAPNs/FCM joriyqilmang; In-App/Webpersistednotificationseam+MobilePush typedcapabilitypending, realdispatchnotimplemented bo‘lsa pending/deferred, SENT/API_ACCEPTED deb yozilmaydi. TelegramenabledfaqatS14typedadaptereligible; realnetworkstillOFF. Parent/student faqatTelegram boundary saqlanadi; bu qaror ularga yangiweb/mobilelogin bermaydi. OPEN_CHANNEL01/02 update faqat userquote/mappingdoirasida, boshqaOPENRBAC/finance qarorlar ochiq qoladi.

Disable/narrowpolicy queuedintentdan keyin; presendlatestintersection+currentstaff/guardianlink qayta tekshiriladi. Re-enable oldexpired/historicalspamni qaytarmaydi. Settingsnewversion /oldqueuedintent /two workers /sameeventmultiplechannels /onechannel429 tests, typedDTO redaction va no privilegeescalation.

## U05 /14.04 — webhook receipt, replay va frontendga yetkazilmaganlar ro‘yxati
Telegram update_id durable center/bot scoped dedup; parallel identicalupdate exactlyone domain execution, sameid differentbody safeconflict/securityaudit. TelegramIDs/dateprecise parser, malformedcontent/unsupportedupdate documented2xx discard yoki4xxretry behavior, nostack/secretleak. Webhookfastdurableack (processinglaterbo‘lsa requiredtransactionalreceipt) networkcallbackslow financialtransactionga bog‘lanmasin. Failedhandler retry dedupcommit bo‘libdomaineffectyo‘q holati bo‘lmasin.

Databasehelpernewtablelar kerak bo‘lsa canonicalentities+technicalhelpersni aniq ajrating, tenantFK/lineage/appendonly/grants/index/TTL/migration/Prismacoverage. Yangi tablebilan immutableupdategrant yoki broadSELECTphoneperteacher kiritmang. DB16fresh+populated9→10upgrade, actualPrismamigrationhistory/checksums; countbumpningo‘ziyetmaydi. Explicitbotdatabasecredentialsyo‘q.

Unlinked/botblocked/transportdisabled/notconfiguredrecipient status operationalAdminlist API (scopeapprovedcurrentoperations, notmonthlypayrollreports), privacyminimal. “Bot read” deb uydirmang. Linkrevoke event handler va staffrevocation scopesafe; data retention unanswered policy PROPOSED bo‘lsa no irreversibleretentiondefault.

## U06 /14.05 — haqiqiy HTTP/PostgreSQL/fakeprovider acceptance
`apps/bot/test/*`, `apps/api/test/bot/*`, workeradaptertestlar meaningful frameworktests; GitHub GateG11 test:bot yoki aniq repo command. Kamida BOT-IT-01..12 mustaqil actualdeclarations:
01 invite/contact bindingpositive;02 foreigncontact/typedphone/expired/crosscenternegative;
03 parallelconsume/replay/relink/phonechange;
04 linkedguardian exactchildsummary/batchprivacy/revokedcallback;
05 internalHMAC/rawbody/timestamp/nonce/wrongsecret/forgedrole;
06 durableupdate_id races/faultrollback/floodlimits;
07 DirectorcallbackrealS09/S10commandpositive+liveRBAC/revocation/expectedversion/replay;
08 templatesescaping/noPII/BigInt/recipientallowlist;
09 fakeprovider429/403/networktimeout/mixedrecipient+leasestale;
10 actualOSsend-crash/recovery internalreceipt/eventstatus+ambiguity;
11 notificationconfiguration defaultALL_OFF/authorizedmulti-select/versiondisablequeued/horizon;
12 realprocess/bootstrap/Docker API+worker+bothealth/internalservice boundary, negativeconfig, leastprivilege.
Additionalgranularcases asneeded; 12IDsbut20assertions unexecutednotclaimedcovered. FixedclockJWTrefresh/finallyrestores, independentfixtures validDBenums/notmissingrequiredcols. StubbedhelpernotHTTPboundaryproof, staticregexcommentsnotimportsproof.

All G1–G10/S13managerregressions retained: groupfee300→future350notcourse600, actual199previouscheckedtests, crossAPI-workerfinancialidentity, repeatpoll historicaldebt0, currentnotificationUNCONFIGfailclosed, childscope, shutdown/SIGKILL. Lockedinstall/generate/lint/strictbuild/OAS3.1/plan, allgatesandDocker actualifavailable; offlineNOT_RUNwhy. Do not weaken productionguards to passfixture.

## U07 — source, docs va topshirish
ADR014, botconfig/README/Docker/compose/CI, OAS/inventory/events/RBACmatrix, actualschema+privileges, S14verification, 14.01..05reports/handoff, ARTIFACT_PROOFclaim→source→assertion→actualrun/hash. Defaultnoactualnetwork/token/realcontacts; configsupportsactualadapterbuttestsallsynthetic. Owner06 exactquoteprovenance, UIconsumersS15/S17 pendingratherthanclaimedimplemented.

Dependencynewworkspaceflags: rootworkspaces/DockerCOPY/packageversions/scripts exactexistingnames; do not invent @eduerp/contracts version or remove test:integration. Newlockneedsmanagerrefresh flagtrue ifunableactualinstall; fake lock/client no. Source inside eduerp-v2, inputmetadata atroot, previoussubmissionarchive root/archive ignoredproductdelta. Output **S14FULL_U_SUBMISSION.zip** in this sameworkspace, exactnew/changedsource+SUBMISSION.json/deletedfiles. TaskID/base/candidate/statusIN_REVIEW fromTASK_INPUT. Usemanager_reference/audit_submission.py exactdelta; reportafterZIP. Globalapproval/execution/TRACKER/CURRENT/managerreviews unchanged byexecutor. StopS15/liveTelegram/gateway/production/payroll.
