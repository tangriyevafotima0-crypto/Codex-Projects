# Argon review kuzatuvlari
Holat: 2026-11-04. Dataset: 7 ta review qilingan artifact — ARGON-01.01-A, S01-FULL-C, S01-FIX-S02-FULL-D , S02FIX-S03FULL-E  , S04FULL-F , S04FIX-S05FULL-G va S04S05FIX-S06FULL-H. Quyidagi bo‘limlar tarixiy review tartibida; eng so‘nggi kuzatuvlar pastda. Model aniqligi yoki token sarfi bo‘yicha statistik o‘lchov yo‘q.

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
