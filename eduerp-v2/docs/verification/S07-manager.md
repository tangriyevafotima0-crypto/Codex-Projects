# S07FIX-J — manager review va acceptance

**REVIEW-PASS**, manager tuzatgan revision uchun. **S07 /07.01–07.05 APPROVED**. S01–S07 jami35/120step=29.17%,7/24stage; bu reja sanog‘i, ERP release tayyorligi foizi emas.

## Manba va exact dalil
- Input base337c2a79a0cd20838298bb772a19e121ced84cc1; candidateinputad56d67c7c08e7c7cb4e80abeccf67c069337bc5.
- Original ZIP23entries(22source+SUBMISSION.json), SHA25630914c0a1ee85c8b1bea2d87fde17d58bab0f92758ce02c59d208435033e0b02. CRC/exactmetadata/filesha/safeunique pathsPASS, lockunchanged.
- Original source:argon/s07fix-j-review, commit3b15b4dcf1f7de8d775359e89dc7cb3b49d254ee.
- Acceptedcode:ce9b99decf4d70d40f51cf3d42791b5d72b1bec7, codex/s07-j-runtime-review.
- StrictCI:https://github.com/tangriyevafotima0-crypto/Codex-Projects/actions/runs/41852850189 — **3/3SUCCESS**.
- Actual33unit/runtime+18DB+14auth+6students+10academics=**81PASS**, migrate deploy twice, Docker Compose migrator/health/readyPASS. Prisma generate, ESLint, strict typecheck/build, Python/plan tests/fullOpenAPIvalidatorPASS.
- Independentmanagerregressionprobe41851711255 atcb5de9238ecae2857d76aff59e39fdb45588243b:grade200→revoke200→oldkey403/newkey403;futuregroupfee650000. Assertli probePASS. Finalacceptedcode faqat testfixturecorrectionlari bilan shu source’dan keyin.

## I01–I06 closure
I01workingbaseline saqlangan. I02gradeSQL helperownership saqlangan, real create/update/read/revisions, invalidseconditembatchrollback, concurrentonewinner va changedpayload409 testlandi. I03pre-cacheauthorization hook transactional; lessonlockdan keyin newsnapshot substitute/currentprimaryni tekshiradi; old/newkey revoked/reassigned403, authorizedsamekey200. I04sharedprice-resolver before/on/aftereffective dates, same-datehigherrevision, as-of, timezoneboundary, BigInt, groupisolation va oldinvoicesnapshotunchanged testlandi. I05independentDirectortransactioncompletion/strictCIbounds saqlangan. I06perfailuremodeACAD-IT11/12/13 actualPGda bajarildi.

## Manager tuzatishlari va original artifact chegarasi
Original J strictTypeScript testda otherTeacherToken e’lon qilinmagani sabab yiqildi. Declaration+loginbinding qaytarildi (endi newcases uni ishlatadi). Keyingi actualG4da uch yangi test400fixture’da to‘xtadi: local_ends_time/code unknownfields, requiredgroupschedulefields yo‘q, group_id o‘rniga id, studentINSERTrequiredfieldsyetishmasligi, nonexistentresponsefields/errorcode, clockadvance’daneskiJWT.
Manager **faqat akademik test faylini** existingDTO/DBschema/responsecontract/JWTlifecyclega mosladi. Primary productfixsource’ini almashtirmadi, APIvalidation yoki authmuddati yumshatilmadi. Expectedsecurity403, one-winner, rollback, snapshot va monetaryamount assertions saqlangan. As-of queryda current_fee projection contractdagi so‘ralganas-ofdate qiymat ekanligi testga moslandi; realtodayread alohidatekshirildi. OriginalsubmittedZIPning offlineNOT_RUN bayonoti tarixiy; originalni81PASS debtalqinqilmang.

## Acceptance va keyingi stage
Workingauth/DATEpoolparser/configtokens/Prisma/Nest/Dockerdependencies/lock/genericcacheboundary saqlangan. I03/I04 materialfindingsclosed; S07scopeida remainingblockingfindingyo‘q. Runtimeperformance/fullUI/pilot/billing engine scope approvedemas.
Next:S08FULL-K,08.01–08.05fullstage. OWNER-20261104-03 centerfirstchargechoice/HALF_UP/rollingactualdaycontinuation qarorini qo‘shdi; boshqaopenformulalar gate ostida. S09adjustments/payment/Telegram/production boshlanmaydi. Source+review+ownerapprovals main’da; originalartifact reviewbranchda.
