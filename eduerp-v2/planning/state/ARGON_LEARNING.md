# Argon review kuzatuvlari
Holat: 2026-11-04. Dataset: 11 ta review qilingan artifact — ARGON-01.01-A, S01-FULL-C, S01-FIX-S02-FULL-D , S02FIX-S03FULL-E  , S04FULL-F , S04FIX-S05FULL-G va S04S05FIX-S06FULL-H. Quyidagi bo‘limlar tarixiy review tartibida; eng so‘nggi kuzatuvlar pastda. Model aniqligi yoki token sarfi bo‘yicha statistik o‘lchov yo‘q.

| ID | Kuzatuv | Hozirgi dalil | Keyingi promptga moslashuv |
|---|---|---|---|
| L01 | Taklif rol huquqi sifatida qat’iy yozilgan | Birinchi artifactda bor; ikkinchisida asosiy origin/status ajratilishi tuzatilgan | Source/proposal/OPEN aniq ajratiladi |
| L02 | Mavjud bo‘lmagan anchorlar | Birinchisida bor; ikkinchisidagi68 anchor va barcha scope locatorlar manager tekshiruvida o‘tdi | Haqiqiy anchor parseri; to‘g‘ri ish qayta yozilmaydi |
| L03 | Source page/section nomuvofiqligi | R22.04/R24.03/R03.01 yaxshilangan; R05.03 kabi residual bor. Bir qismi manager mappingidan meros | Asl manba ustuvor; inherited xatoni takrorlamaslik |
| L04 | Raw phone maxfiyligi noaniq | Ikkinchi artifactda boundary aniq; aloqasiz OPEN_RBAC ID qayta ishlatilgan | Privacy baseline va unique qaror ma’nosi tekshiriladi |
| L05 | Keng PASS da’vosi isbotdan katta | Ikkala reviewda turli ko‘rinishda uchragan | Har checkning real qamrovi va run natijasi |
| L06 | Published checker compile bo‘lmaydi | Ikkinchi artifact literal skripti line5 SyntaxError; PASS matni buni oqlamaydi | Executable file + syntax check + aynan shu fayl stdouti |
| L07 | Given/When umumiy vazifani takrorlaydi | Ikkinchi artifactda96 row | Konkret precondition, command va observable natija |
| L08 | Cross-feature biznes chegaralari yetarli emas | Discount×freeze, refund×method, cycle×reactivation | S02ga shu misollar bilan schema/API/event mosligi |

Kuchli natijalar: ikkala artifactda fayl/transport tartibi, hashlar va119 ID set mos. Ikkinchi artifact hajmi sezilarli kattaroq bo‘lsa ham bu struktura saqlangan.
Keyingi review: qaysi finding yopildi, qaysisi takrorlandi, yangi issue, manager/ijrochi/shared sabab va promptga eng qisqa foydali o‘zgarish yoziladi.

## Uchinchi artifact — S01-FIX-S02-FULL-D
Manager haqiqiy skriptni compile+run qildi:PASS,5negative test o‘tdi. Quote/control/CSV GivenWhen/source-set tuzatishlari sezilarli yaxshilangan. S01docstage manager reviewdan o‘tdi, P2coverage-label risk nextbatchda.
Yangi kuzatuvlar: L09 generic POSTauthguard publicloginni ham bearerga bog‘lagan; L10 field/row classification o‘zaro zid; L11 localrefsoni usecase/securitycoverage emas; L12 producerdedup consumerdedup o‘rnida ishlatilgan. Kelasi prompt: positive+negative semantic invariant va lifecycle-crosscheck, faqatcountemas. L05coverage overclaim qisman davom etgan. Dataset3artifact, modelga umumiy statistik hukm yo‘q. Attachmentmismatch usertransportholati, Argonxatosi deb hisoblanmaydi.

## To‘rtinchi artifact — S02FIX-S03FULL-E
S02fixes improved:55operations,structuredownership,46entitycatalog,consumerreceipts/fencing,actualcaseoracles. Managerchecker+fullOpenAPIvalidatorPASS. Original9tests/lint/tscbuildPASS;actualNestbootFAILandworkerprocessimmediatelyexited. Managerfixedand14actual/unit tests+CIdockerpassed.
L13:helper HTTPserver/functionstoptestisnotdeployedframework/processlifecycle. Prevention:actualcompiledentrypoint+realHTTP/OSsignal.
L14:copyingonlyhoistednode_moduleslosesworkspace-localdependencies;dockerignorehidrequiredcontractassets. Prevention:realcontainerbuild+composehealth,notYAMLparseonly.
L15:availableVMruntimeisnotprojectsupportedtarget;Node18EOLwaschosenfromVM. Prevention:preserveNode24target,explicitverifiedversions,offlineNOT_RUNratherthandowngrade.
L16:blanket.sqlignore/secretfilebanblockslegitimatemigrations. Prevention:allowtrustedsourcepaths,forbidrealDBdumps/keys.
Managerclosedthesefixesinthisturn;donotaskArgontorecreateorrevertcorrectbaseline. Dataset4artifacts,notamodelbenchmark.

## Beshinchi artifact — S04FULL-F
Kuchli jihat:49 source hash mos, keng46model/SQL/CI draft, offlineNOT_RUN va lockfile chegarasi halol. Pythoncheckerlari actualPASS. Manager install+lintPASS, lekin actualgenerate/typecheck/bootFAIL.
L17: schema modeli count/ref tekshiruvi Prisma relation validator o‘rnini bosmaydi; next:real validate/generate.
L18: nomi PrismaClient bo‘lgan cast oddiy obyektni ORM qilmaydi, ambient adapter declaration mismatchni yashiradi; next:official types+actual ORM roundtrip.
L13 takrorlandi: parent config child DBModulega ko‘rinmagan va duplicate provider actualNestbootni buzdi. Next:single provider+real bootstrap.
L19: tenant centerFK borligi same-center student/enrollment lineage to‘g‘riligini isbotlamaydi. ActualPG wrong attendance insertni qabul qildi; next:negative wrong-lineage DB tests.
L20: sequential COUNT last-director himoyasi race-safe emas; actual2transactiondan keyin0activeDirector. Next:stable shared serialization+concurrentDBtest.
L21: idempotency scoped lookup va unscopedUUID PK nomuvofiq, actualsameUUID otheroperation23505. Next:storage/lock/lookup identity bir xil.
L22: DB harness workspace cwd, role-grants overwrite va CLI o‘rniga fake migration history. Next:unmodified workspacecommand,realCLI,distinctcredentials,failedsetupcleanup.
L05coverage chegarasi:20DB-IT label16case degani20mustaqil acceptance emas; missing financialrollback/driftmutation/upgrade/retrylimit dalillari. Next:test-to-failuremode mapping.
Sharedtooling: manager S04reference TSupgrade aytib inheritedNode18typesni explicit yangilamagan; Node24typeskeyingipaketga kiritildi. Bular5artifact kuzatuvi, statistik modelbenchmark emas.

## Oltinchi artifact — S04FIX-S05FULL-G
Old Prisma/Nest/scoped PK/lineage DB ishlari yaxshilandi:manager compile assistsdan keyin G1 realPG17/17PASS,unit/process22/22PASS. Original offline NOT_RUN halol; live auth6/8PASS.
L23: idempotency hamma operatsiyaga birday qo‘llanib auth secret replay/storage boundary buzilgan. Real wrongpassword+oldkey200 va oldtoken; genericclientlogda rawrefresh. Next:authcredential verification cache’dan oldin va genericsecret-replay storage yo‘q.
L24: outerFORUPDATE+autonomousconnection innerUPDATE bir-birini kutadi; actualbadpassword500,count0. Next:commit failureoutcome in same tx,throw aftercommit; persisted/shared bounded rate limit.
L25: Composeconfig nomi kodnomidan farq qiladi; migrator runnerCLIprune bilan kelgan. Next:config contract test+actualtoolingcontainer path.
L26: “bugungi substitute” hujjatda bor, SQLda date predicate yo‘q. Next:temporal entitlement tests past/today/future center timezone.
L27: security unit/hash tests login protocol semanticsni yopmaydi; 17AUTHlabel8actualtest. Next:semantic false-positive regression hamda liveHTTP/PG mandatory.
Manager mechanical compile corrections allaqachon nextinputda:readonlypgbind copy,unused cleanup,BillingModeexport,contractsbuildorder,actual lock. Ularni qayta yozmang. Dataset6artifacts, statistik model benchmark emas.

## Yettinchi artifact — S04S05FIX-S06FULL-H
G01/G02actualfixed:oldwrongpasswordreplay401,no rawrefreshcache,countercommit. Managerrepairsdan keyin64tests+strictCI418325723943/3SUCCESS.
L28:decorator/controller/service import cycle configtokenundefined qildi. Next:pure tokens.ts module vaactualbootstrap.
L29:DATEcalendarvalue localDate→UTCISO bilan birkun surildi. Next:driver-boundarycalendarstrings,UTC/TashkentactualDBtest;lessonTZtests.
L30:testcustomroles productiondefaultrolebootstrapprivilegesni yopmagan; actualDockerALTERROLEfail. Next:clusterroleopsadminbootstrapda,migratortableschemaonly.
L31:INSERTcolumncount checker SELECTwrongcolumns+fixturearityni tutmagan. Next:actual SELECT/endtoendfixture,notcountapproval.
L14repeat:minimalDockercopy yana workspace-local Nestdepsni yo‘qotdi. Managerpreservedproperprodlocalcopy.
L32:futurebotURL/refhash mosligi va realissuance yo‘q edi. Next:futureintegrationpendingexplicit;S06relinkmetadatanullURL,S14actualissuance.
L33:2pycoutputartifactkeraksiz;exactrawZIPreviewbranchda,productcachefree.
Manager-induced broadINSERTVALUESreplacement strictCIcatchqildi va scope-specificfixbo‘ldi;Argonxatosi debhisoblanmaydi. NextmanagereditsmaydoncontextvaactualG3fixturebilantekshiriladi.
Dataset7artifacts,statistikbenchmarkemas. P2R1limiterfailclosed/R2explicitreuse nextpacketgaassigned.


## Sakkizinchi artifact — S07FULL-I
Kuchli jihat:48source hash/lock/cache discipline yaxshi; offline NOT_RUN halol; R1fail-closed/R2explicitreuse actual HTTP/PGda ishladi. Manager assistsdan keyin76tests+Docker strictCI418430914873/3SUCCESS, ammo2semantic finding OPEN. S07approval yo‘q.
L34:helper SET ownershipni bilmagan callsite updated_atni ikki marta yozdi; actualgrade500. Prevention:real helper SQL roundtrip + isolated grade positive/negative tests. Manager minimalfix inputda.
L23/L26 yangi kesishma:authorization faqat new idempotency handlerda; cached grade response revokeddan keyin200. Prevention:current object check BEFORE cache response, samekeyafterrevoke/reassign test. Bu rawcredential storage takrorlandi degani emas; umumiy cache/auth boundary patterni.
L35:futuregroup pricehistorywrite bor, effective date o‘tgach groupreadprojection eski. Prevention:clock advance BEFORE/ON/AFTER va authoritative as-ofresolver barcha readlarda.
L36:typed harness property ixtiro qilingan, ACL correct DB identity tekshirilmagan. Prevention:real interface + target DB/role, cleanupgrantfinally. Managerfixed.
Inherited/shared tooling:oldDB-IT-19 wait-both-before-commit nondeterministic hang. Argonnewregressionimas. ManagerindependentCOMMIT/ROLLBACK+assertonewinner+CIboundsfixqildi. Runtimeprobe ilkfixturesnapshot missing edi, managerfixture correction; Argonxatosi deb hisoblanmaydi.
L05coverage yana:76existingtestsPASS2adversarialsemanticsni isbotlamadi. PromptJcountquotaemas,failuremodeassertionlarni talabqiladi. Dataset8artifact, statistik modelbenchmark yoki token-efficiency o‘lchovi yo‘q.


## To‘qqizinchi artifact — S07FIX-J
Kuchli:jaryoncacheauthorizationhook va sharedtariffresolver ikkiactualsemanticbugniyopdi;oldkeyafterrevoke403/futurefee650000. Coreproductsource manager semanticrewrite’sizqabulqilindi. Onetestfilemanagerassistsdan keyin81tests+strictCI418528501893/3SUCCESS, S07APPROVED.
L36repeat:newcases ishlatgan otherTeacherToken DECLARE/initializeyo‘q;actualtsc2304. Oldfixni blindlypreserve qilish yangi reference bilan yetmaydi. Next:readnewtestidentifiers/declarations+strictbuild.
L37:newfixtures existingDTOga zid local_ends_time/code, requiredschedulefieldsyetishmagan, group_id o‘rniga id, requiredstudentfields yo‘q, nonexistentresponse/errorfields. ActualG4three400cases behaviorga yetmagan. Next:typedfixturebuilder,actualrequest/response/sourcecrosscheck,notimaginedAPI. Testexpectedinvariantsremovedemas;payloadcanonicalized.
L38:Clockforward kunlarga tokenexpirationreal, eskiJWTbilan futuretarifftest401bo‘lardi;managerrelogin helper. Next:controlledtime +freshcredentials, securityexpirepolicyunchanged.
I06yaxshilanish:separatecasesfailureisolation;BigInt/as-of/timezone/revokeparallelassertionspositive. OfflineNOT_RUNhalol,ammonode-transpilePASS strictbuild/PGproofemas.
Dataset9artifact,statistikmodelaccuracy/tokenbenchmarkemas. Managerfixbirtestfileda,productfixlarArgonniki. UserworkingpreferencekattafullstageKsaqlanadi, pendingpolicymutatsiyalargate.


## O‘ninchi artifact — S08FULL-K, 2026-11-05
Kuchli:32sourcehash/lock/packagediscipline;exactBigIntHALF_UP/rollingclamphelpers;39actualunit/runtimePASS,manager2testassistdan keyinG1–G4PASS. OfflineNOT_RUN halol. S08CHANGES_REQUIRED,91actualPASS/4FAILoverallFAIL.
L36repeat:ASTidentifiercheck mavjudbo‘lmaganexportni o‘tkazgan;3fakeharnessimport tsc2305. Next:realmoduleexports/APItypedfixture,strictresolvercheck,sourceexistingpatterncopy.
L37repeat:student400/schedule409fixtures actualfeatureassertionsoldidayiqildi. Next:isolateduniqueDTO-compatiblebuilders,hiddenassertionsNOT_RUN, failuresnotmasked.
L39:enumliteral25char lekinDBVARCHAR24, actualDirectorpolicy500. Next:allnewenumvaluesSQLwidth/CHECK/Prismaroundtrip; staticcountapprovalemas.
L40:per-helperformula to‘g‘ri bo‘lsa ham eligibilitymissing:TRIAL0attendanceinvoice200/debt480000;enrollmentNov12→Octinvoice200/debt480000. Next:state×time×entrypoint adversarialdeny+zerorowsbeforepositiveformula. Publicmanual+internalworker+trial raceboundary.
L41:migrationdefault/mapperlegacyUNKNOWN→CONFIRMEDqulayfallbackfailopen. Next:explicitActor+policyversion+effectivedateconfirmation;oldrowsfailclosed, fixtureconfirmationproductionemas.
L42:newmigration regressionexpectedcount/upgradeoldsetstale. Managermechanicallyfixed5history+upgrade; nextschema lifecycleallmigrationstestednotcountbumpalone.
Manager2testfilesassists,productfinancialdefectsArgonfixnextL. Dataset10artifacts,statisticalmodelaccuracy/tokenbenchmarkemas. Invalidwidth/schema+eligibilityheavierthanminorfix; fullS08acceptanceL, S09gated.


## O‘n birinchi artifact — S08FIX-L, 2026-11-05
Kuchli:K02legacygate/K03TRIAL/K04priorperiod/K05widthactualclosed;explicitconfirmednegative+positivecontrolownerboundaryto‘g‘ri. LoriginalstrictcompilePASS,41actualunit/runtimePASS. Managerone-testfileenumsfixdan keyin100PASS/1FAILoverallFAIL,1newP1independentpackageprobe.
L37repeat:SQLenumliteralotherdomain’danborrowqilingan(STAFF_WEB/creditreasonPRIOR_FREEZE_CREDIT). Next:canonicalconstraint-backedtypedfixtures; invoiceLineenumCreditNoteenumemas. Managerfixedtestonly.
L43:oldownershipruntimecalendarprefix’danrecompute;backdatedlessoninsert PKG2alreadyconsumeddarsniyana hisoblagan,remaining1expected2. Next:immutablepersistedcyclemembership, post-issuancehistorymutationadversarialtests;namealreadyAllocatedhistoryproofemas.
L44:calendarfixtureweekdayassumptionNov30Mondaynitutmagan;Nov29latejoin0debdayer1lessonvalid. Next:calendardatescompute/assert,realzerolessonfixture; productvalidationni testassertionga moslabyumshatmang.
L05coverage:staticPKG1→PKG2pass, schedulemutatedsequencefail. Next:statebefore/aftermutation,durableDBownershipandcompoundfeaturematrix;countsnotapproval.
Userowner04harcenterdiscountstacking/freezecreditchoice. NextM explicitlyS08fix+S09fullcandidate,feature-specificpolicyconfirmation(oldS08CONFIRMEDnewS09approvalemas). Dataset11artifact,statisticalmodelbenchmarkemas.


## O‘n ikkinchi artifact — S08FIX-S09FULL-M,2026-11-05
Kuchli:durablepackageownership haqiqiybackdatedprobeclosed;feature-specificpolicygate/centerconfig to‘g‘ri. Originalarchivehash/lock/NOT_RUNdiscipline saqlangan. S08/S09 manager-assistedaccepted, exactCI/evidence reviewda.
L36/L37repeat:nonexistenthelperoption, appbootstraplogger o‘rniga db, outdatedenum/principal/portfixture; next actualexport/type/helpercontractsread, strictcompileandrealHTTPbeforecoverageclaim.
L45:immutable credit_notes/freeze_lesson_links SELECTFORUPDATE PostgreSQLdaUPDATEprivilegetalabqiladi;runtime500. Grantniweakenqilmasdanmutableenrollmentserialization; next realrolequerypermissions+positivefinancialflow.
L46:perrequestHALF_UPsegmentationsum24999vsunion25000. Next cumulativeallocationroundedtotal-deltamodel va multiplepartitions/dust/cappropertytests.
L47:futurewithdrawalflagdeny,actualfuturedateunguarded. Next actualeffectiveDatevscenterClockcrossentrypointdeny; midnightTZ/replay/stateunchangedassertions.
L42repeat:exactimmutablecatalognewhelperstale;next compareactualsetnotcounts. Managerchanges10projectfiles; managerprobeoldwrongURL404correctedbeforepositiveclaim, notArgonbug. Dataset12artifacts, statisticalaccuracy/tokenbenchmarkemas. NextS10 coherentfullstage+realpaymentrecordboundariesowner05;moreworkdoesnotmeanunverifiedapproval.
