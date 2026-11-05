# EduERP v2.0 — Transactional Outbox Hodisalar Katalogi, Lease Fencing, Consumer Receipt Dedup va Telegram Yetkazib Berish Semantikasi (`docs/architecture/events.md`)

<a id="evt-meta"></a>
- **Task / Step ID:** `S02FIX-S03FULL-E` / Step `02.04` (`T02.04` — `S2F03`, `S2F04`, `S2F06` tuzatishlari bilan yangilangan tahrir)
- **Base Commit:** `4a9ba11baf08460579d80f262b5c65b6ad64a6d1`
- **Asosiy manbalar:** `planning/03_ARCHITECTURE.md`, `planning/05_DOMAIN_RULES.md`, `docs/spec/business-rules.md` (`BR-03`–`BR-17`, `C03`, `C04`), `docs/architecture/data-model.md` (`outbox_events`, `outbox_consumer_receipts`, `notification_deliveries`), `docs/architecture/openapi.yaml`, `planning/state/reviews/S01-S02-D.md`.
- **Hujjat maqomi:** `IN_REVIEW` (Stage 02 hodisalar va asinxron navbat spetsifikatsiyasi; bajariladigan outbox business worker kodi Stage 13–14 da yoziladi va real DB poyga testlari o‘sha bosqichda isbotlanadi).

---

<a id="evt-envelope-and-outbox-tx"></a>
## 1. Umumiy Outbox Konverti (`Event Envelope`), Producer vs Consumer Dedup va Transactional Outbox Qoidasi (`T02.04`, `S2F04`)

### 1.1. Atomik Producer Tranzaksiyasi (`Producer DB Transaction`)
Hech bir servis tashqi tarmoqqa (Telegram Bot API ga) DB tranzaksiyasi ichida sinxron murojaat qilmaydi. Barcha domen hodisalari (`PaymentRecorded`, `AttendanceSubmitted` va b.) biznes o‘zgarishi (`Payment`, `AttendanceRecord`, `AuditLog`) bilan **aynan bitta PostgreSQL ACID tranzaksiyasida** `outbox_events` jadvaliga yoziladi (`03_ARCHITECTURE.md`, `T02.04`, `T04.03`, `T10.01`).

### 1.2. Producer `dedup_key` va Consumer `consumer_receipt_key` Farqi (`S2F04`)
- **Producer Dedup (`outbox_events.dedup_key`):** Faqat hodisaning `outbox_events` jadvaliga ikki marta yozilishini oldini oladi (`UNIQUE (dedup_key)` va `UNIQUE (center_id, aggregate_type, aggregate_id, aggregate_version)`). **Producer `dedup_key` hech qachon consumer effektini dedup qilmaydi!**
- **Consumer Dedup (`outbox_consumer_receipts.consumer_receipt_key`):** Bitta outbox hodisasi bir nechta ichki consumer (`TrialConversionConsumer`, `TelegramNotificationConsumer` va b.) tomonidan o‘qilishi yoki worker crash/retry tufayli qayta olinishi mumkin. Shu sababli har bir ichki DB consumer o‘z domen o‘zgarishini (`Invoice`, `CreditNote`, `PromiseToPay` va h.k.) hamda `outbox_consumer_receipts (center_id, consumer_name, outbox_event_id, consumer_receipt_key, fencing_lease_token)` yozuvini **bitta atomik DB tranzaksiyasida** kiritadi (`S2F04`).

### 1.3. Standart Hodisa Konverti (`Canonical Event Envelope Schema`)
Har bir hodisa `outbox_events` jadvalida quyidagi majburiy ustunlar va PII-minimal payload bilan saqlanadi:

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_name": "PaymentRecorded",
  "schema_version": 1,
  "center_id": "11111111-2222-3333-4444-555555555555",
  "center_slug": "guliston-ilm",
  "aggregate_type": "Payment",
  "aggregate_id": "99999999-8888-7777-6666-555555555555",
  "aggregate_version": 1,
  "lease_token": 1,
  "dedup_key": "center:11111111:PaymentRecorded:99999999:v1",
  "source_operation_id": "op-pay-20261112-001",
  "actor_type": "STAFF",
  "actor_id": "aaaa1111-bbbb-2222-cccc-333333333333",
  "actor_role": "ADMIN",
  "occurred_at_utc": "2026-11-12T06:15:30Z",
  "payload": {}
}
```
- **PII-Minimal Payload Qoidasi:** `payload_json` ichida ota-onaning ochiq telefon raqami (`phone_e164`) yoki parol/tokenlar saqlanmaydi; faqat `student_id`, `guardian_id`, `invoice_id`, `amount_uzs` (integer string, `scale=0` — `C03`, `S2F07`) va status IDlari bo‘ladi. Worker xabar yuborishdan oldin `guardian_telegram_links` jadvalidan `status = 'ACTIVE'` chatni jonli tekshiradi (`05_DOMAIN_RULES.md`, `D18`).

---

<a id="evt-versioned-catalog"></a>
## 2. Versiyalangan Hodisalar Katalogi (`15 Domain Events` — `S2F06`)

| № | Event Nomi (`event_name`) | Versiya | Producer Operatsiya (`openapi.yaml`) | Aggregate & Producer `dedup_key` | Consumer(lar) va `consumer_receipt_key` / Fanout Qoidasi (`S2F04`) | PII-Minimal Payload Maydonlari |
| :-: | :--- | :---: | :--- | :--- | :--- | :--- |
| <a id="evt-PaymentRecorded"></a>**1** | **`PaymentRecorded`** | `v1` | `recordPaymentWithRequiredPromise` | `Payment` (`v1`)<br>`dedup_key = "PaymentRecorded:{payment_id}"` | `TelegramNotificationConsumer`: `notification_deliveries (outbox_event_id, 'GUARDIAN', guardian_id)` orqali ota-onaga ichki elektron kvitansiya (`receipt_number`, `amount_uzs`, `remaining_debt_uzs`, `next_due_date`) yuborish (`BR-05`, `D13`, `T02.04`). | `payment_id`, `receipt_id`, `receipt_number`, `student_id`, `amount_uzs`, `currency:"UZS"`, `payment_method`, `allocated_total_uzs`, `unapplied_credit_uzs`, `remaining_debt_uzs`, `promise_id`, `promise_date` |
| <a id="evt-AllocationAdjusted"></a>**2** | **`AllocationAdjusted`** | `v1` | `recordPaymentWithRequiredPromise`, `issueBillingCycleInvoice`, `decidePaymentReversalOrRefund` | `Invoice` (`vN`)<br>`dedup_key = "AllocationAdjusted:{invoice_id}:v{version}"` | 1) `PromiseLifecycleConsumer` (`receipt_key = "PromiseLifecycleConsumer:{event_id}:{invoice_id}"`): `remaining_debt_uzs == "0"` bo‘lsa ochiq `PromiseToPay` ni `FULFILLED`/`CANCELLED` qilish (`T11.03`);<br>2) `ReportProjectionConsumer` (`receipt_key = "ReportProjectionConsumer:{event_id}:{invoice_id}"`). | `invoice_id`, `enrollment_id`, `student_id`, `allocation_id`, `allocation_reversal_id`, `delta_allocated_uzs`, `new_remaining_debt_uzs`, `invoice_status` |
| <a id="evt-RefundRecorded"></a>**3** | **`RefundRecorded`** | `v1` | `requestPaymentReversalOrRefund`, `decidePaymentReversalOrRefund` | `ReversalOrRefundRequest` (`v1`..`v2`)<br>`dedup_key = "RefundRecorded:{request_id}:v{version}"` | 1) `PENDING_DIRECTOR_APPROVAL` da: `TelegramNotificationConsumer` (`notification_deliveries` -> `DIRECTOR`) orqali **darhol qizil ogohlantirish** va tasdiqlash tugmasini yuborish (`PDF p.3, 5`, `BR-07`);<br>2) `APPROVED_EXECUTED` da: `ShiftAndReportConsumer` (`receipt_key = "ShiftAndReportConsumer:{event_id}:{execution_id}"`) smena va hisobotni yangilash (`C03`, `D22`, `S2F03`). | `request_id`, `execution_id`, `original_payment_id`, `student_id`, `kind`, `amount_uzs`, `refund_method`, `debt_effect_policy`, `status`, `requested_by_admin_id`, `approved_by_director_id` |
| <a id="evt-AttendanceSubmitted"></a>**4** | **`AttendanceSubmitted`** | `v1` | `submitLessonAttendance`, `syncOfflineAttendanceBatch`, `commitExcelImportBatch` | `LessonOccurrence` (`vN`)<br>`dedup_key = "AttendanceSubmitted:{lesson_id}:v{version}"` | 1) `TrialConversionConsumer` (`receipt_key = "TrialConversionConsumer:{event_id}:{enrollment_id}"`): 2-distinct darsda `PRESENT`/`LATE` bo‘lgan `TRIAL` o‘quvchini faollashtirish (`BR-03`, `T02.04`, `T12.04`);<br>2) `TelegramNotificationConsumer`: har bir `ABSENT`/`LATE` talaba vasiysi uchun `notification_deliveries (outbox_event_id, 'GUARDIAN', guardian_id)` qatori bo‘yicha xabar yuborish (`S2F04`). | `lesson_id`, `group_id`, `lesson_date`, `occurrence_seq`, `client_operation_uuid`, `submitted_by_staff_id`, `absent_student_ids[]`, `late_student_ids[]`, `present_trial_enrollment_ids[]` |
| <a id="evt-AttendanceCorrected"></a>**5** | **`AttendanceCorrected`** | `v1` | `submitLessonAttendance` (`source=ADMIN_OVERRIDE`) | `AttendanceRecord` (`vN`)<br>`dedup_key = "AttendanceCorrected:{attendance_record_id}:v{revision_version}"` | 1) `TrialCompensationConsumer` (`receipt_key = "TrialCompensationConsumer:{event_id}:{enrollment_id}"`): agar 2-trial dars `PRESENT` dan `ABSENT` ga tuzatilgan bo‘lsa, `TrialCompensated` oqimini ishga tushirish (`C04`, `BR-03`);<br>2) `TelegramNotificationConsumer`: `notification_deliveries` orqali tuzatish xabarini yuborish (`T12.04`). | `attendance_record_id`, `revision_version`, `lesson_id`, `student_id`, `enrollment_id`, `previous_status`, `new_status`, `override_reason`, `actor_staff_id` |
| <a id="evt-TrialActivated"></a>**6** | **`TrialActivated`** | `v1` | `submitLessonAttendance` (via `TrialConversionPort`) | `TrialActivation` (`seq`)<br>`dedup_key = "TrialActivated:{enrollment_id}:seq:{trial_activation_seq}"` | `BillingInvoiceConsumer` (`receipt_key = "BillingInvoiceConsumer:{event_id}:{trial_activation_id}"`): `first_trial_date` sanasidan boshlab `BillingCycle` va `Invoice` (`280,000` so‘m pro-rata yoki paket) yaratish (`BR-03`, `C04`, `T08.03`). | `trial_activation_id`, `enrollment_id`, `student_id`, `group_id`, `trial_activation_seq`, `first_trial_lesson_id`, `first_trial_date`, `second_trigger_lesson_id`, `generated_invoice_id` |
| <a id="evt-TrialCompensated"></a>**7** | **`TrialCompensated`** | `v1` | `submitLessonAttendance` (`ADMIN_OVERRIDE` on 2nd trial) | `TrialActivation` (`seq`)<br>`dedup_key = "TrialCompensated:{enrollment_id}:seq:{trial_activation_seq}"` | `BillingCompensationConsumer` (`receipt_key = "BillingCompensationConsumer:{event_id}:{trial_activation_id}"`): xato aktivlashgan invoice’ga `CreditNote` + `CreditNoteApplication` yozib `VOID_COMPENSATED` qilish va `Enrollment.status = 'TRIAL'` ga qaytarish; keyingi haqiqiy darsda `seq + 1` bilan qayta aktivlashishga yo‘l ochish (`C04`, `S2F03`, `CASE-06`). | `trial_activation_id`, `enrollment_id`, `trial_activation_seq`, `voided_invoice_id`, `compensation_credit_note_id`, `credit_note_application_id`, `compensated_amount_uzs`, `reason` |
| <a id="evt-DiscountApproved"></a>**8** | **`DiscountApproved`** | `v1` | `decideDiscountOrGrantRequest`, `executeDirectorApprovalCallbackFromBot` | `DiscountRequest` (`vN`)<br>`dedup_key = "DiscountApproved:{discount_request_id}:v{version}"` | `BillingAdjustmentConsumer` (`receipt_key = "BillingAdjustmentConsumer:{event_id}:{discount_request_id}"`): Rahbar tasdiqlagan 50% chegirma, oilaviy chegirma yoki 100% Grant (`net_charge = 0`) ni `Invoice` ga qo‘llash (`BR-04`, `D14`, `T09.02`). | `discount_request_id`, `approval_id`, `enrollment_id`, `target_invoice_id`, `discount_kind`, `applied_amount_uzs`, `new_effective_net_charge_uzs`, `director_staff_id`, `approval_channel` |
| <a id="evt-FreezeCreditIssued"></a>**9** | **`FreezeCreditIssued`** | `v1` | `createFreezeAndIssueCreditNote` | `FreezeRecord` (`v1`)<br>`dedup_key = "FreezeCreditIssued:{freeze_record_id}"` | `BillingCreditConsumer` (`receipt_key = "BillingCreditConsumer:{event_id}:{freeze_record_id}"`): kesishgan darslarni dedup qilib, `invoice.effective_net_charge_uzs` asosida (`C03` cap bilan) keyingi `BillingCycle` uchun `CreditNote` chiqarish va yangi invoice chiqqanda `CreditNoteApplication` yozish (`BR-08`, `D14`, `S2F03`, `T09.03`). | `freeze_record_id`, `credit_note_id`, `enrollment_id`, `source_invoice_id`, `distinct_frozen_lessons`, `basis_net_charge_uzs`, `calculated_credit_uzs` |
| <a id="evt-PromiseDue"></a>**10** | **`PromiseDue`** | `v1` | `PromiseReminderJob` (`09:00` center local time) | `PromiseToPay` (`vN`)<br>`dedup_key = "PromiseDue:{promise_id}:{promise_date}"` | 1) `TelegramNotificationConsumer` (`notification_deliveries` -> `GUARDIAN`);<br>2) `AdminTaskConsumer` (`receipt_key = "AdminTaskConsumer:{event_id}:{promise_id}"`): soat `09:00` da `remaining_debt_uzs > 0` ekani qayta tekshirilgach, ota-onaga va Adminga (`OPEN_CHANNEL_02`) eslatma yuborish (`BR-05`, `T13.02`). | `promise_id`, `student_id`, `invoice_id`, `promise_date`, `verified_remaining_debt_uzs` |
| <a id="evt-PromiseFulfilled"></a>**11** | **`PromiseFulfilled`** | `v1` | `recordPaymentWithRequiredPromise`, `decideDiscountOrGrantRequest` | `PromiseToPay` (`vN`)<br>`dedup_key = "PromiseFulfilled:{promise_id}:v{version}"` | `SchedulerCancelConsumer` (`receipt_key = "SchedulerCancelConsumer:{event_id}:{promise_id}"`): qarz va’da sanasidan oldin `0` bo‘lganda `09:00` eslatmasini bekor qilish (`BR-05`, `CASE-22`, `T11.03`, `T13.02`). | `promise_id`, `student_id`, `invoice_id`, `fulfilled_by_payment_id`, `fulfilled_at_utc` |
| <a id="evt-TeacherPingDue"></a>**12** | **`TeacherPingDue`** | `v1` | `TeacherPingAndEscalationJob` | `LessonOccurrence` (`vN`)<br>`dedup_key = "TeacherPingDue:{lesson_id}:{stage_20m_or_end}"` | `StaffAlertConsumer` (`notification_deliveries` -> `TEACHER` / `ADMIN`): dars boshlanganidan `20 daqiqa` o‘tib davomat submit bo‘lmasa `pay_recipient_teacher_id` ga ping (`STAGE_20M_PING`), dars tugaganda esa Adminga escalation (`STAGE_END_ADMIN_ESCALATION`) yuborish (`BR-12`, `OPEN_CHANNEL_01`/`02`, `T13.03`). | `lesson_id`, `group_id`, `effective_teacher_id`, `escalation_stage`, `starts_at_utc`, `ends_at_utc` |
| <a id="evt-ShiftClosed"></a>**13** | **`ShiftClosed`** | `v1` | `closeCashShiftAndReconcile` | `CashShift` (`vN`)<br>`dedup_key = "ShiftClosed:{shift_id}:v{version}"` | `TelegramNotificationConsumer` (`notification_deliveries` -> `DIRECTOR`): Rahbarning Telegram botiga kechki kassa hisobotini yuborish (`BR-09`, `T11.04`, `T14.03`). | `shift_id`, `shift_date`, `opening_cash_uzs`, `cash_receipts_uzs`, `non_cash_receipts_uzs`, `cash_refunds_uzs`, `non_cash_refunds_uzs`, `cash_expenses_uzs`, `expected_closing_cash_uzs`, `counted_closing_cash_uzs`, `discrepancy_uzs` |
| <a id="evt-GuardianLinkRevoked"></a>**14** | **`GuardianLinkRevoked`** | `v1` | `updateGuardianPhoneAndRevokeBot` | `GuardianTelegramLink` (`vN`)<br>`dedup_key = "GuardianLinkRevoked:{link_id}:v{version}"` | `BotSessionCacheConsumer` (`receipt_key = "BotSessionCacheConsumer:{event_id}:{link_id}"`): ota-ona telefoni o‘zgarganda yoki vasiy unlink qilinganda eski `telegram_chat_id` keshini darhol tozalash va navbatdagi jo‘natilmagan xabarlarni `SKIPPED_UNLINKED` qilish (`D18`, `B16`, `T14.01`, `T14.02`). | `link_id`, `guardian_id`, `revoked_telegram_chat_id`, `revoke_reason`, `revoked_at_utc` |
| <a id="evt-LicenseStateChanged"></a>**15** | **`LicenseStateChanged`** | `v1` | `updateCenterLicenseKillSwitch` | `CenterLicense` (`vN`)<br>`dedup_key = "LicenseStateChanged:{center_id}:v{version}"` | `CenterLicenseGuardConsumer` (`receipt_key = "CenterLicenseGuardConsumer:{event_id}:{center_id}"`): markaz API va Worker keshini yangilash; `READ_ONLY` ga o‘tganda yangi biznes mutatsiyalarini bloklash; `ACTIVE` ga qaytganda oflayn navbatni qayta tekshirish (`BR-15`, `D17`, `D23`, `T19.02`–`19.04`). | `center_id`, `center_slug`, `previous_mode`, `new_license_mode`, `valid_until_utc`, `grace_until_utc`, `signature_key_id` |


### 2.1. Stage 11–12 Amalga Oshirilgan Qo‘shimcha Operatsion Outbox Kontraktlari (`ExpenseRecorded`, `ExpenseReversed`, `AttendanceCorrected`)
- <a id="s11-expense-events"></a>**`ExpenseRecorded` (`v1`, `aggregate_type = 'CashExpense'`, `producer = recordCashOrCardExpense`):**
  - `dedup_key = "ExpenseRecorded:{expense_id}:v1"`
  - Payload: `expense_id`, `cash_shift_id`, `category`, `amount_uzs` (musbat integer string), `payment_method`, `reason_and_doc`, `reverses_expense_id: null`, `recorded_by_staff_id`.
- **`ExpenseReversed` (`v1`, `aggregate_type = 'CashExpense'`, `producer = recordCashOrCardExpense` / `reverseExpenseById`):**
  - `dedup_key = "ExpenseReversed:{reversal_expense_id}:v1"`
  - Payload: `reversal_expense_id`, `reverses_expense_id` (asl xarajat IDsi), `cash_shift_id`, `category`, `amount_uzs` (manfiy integer string), `payment_method`, `reason_and_doc`, `recorded_by_staff_id` (`DIRECTOR`).
- **`AttendanceSubmitted` (`v1`) va `AttendanceCorrected` (`v1`) Stage 12 Runtime Producer Tafsilotlari (`apps/api/src/attendance/attendance.events.ts`):**
  - `AttendanceSubmitted` payload: `lesson_id`, `group_id`, `lesson_date`, `occurrence_seq`, `client_operation_uuid`, `submitted_by_staff_id`, `absent_student_ids[]`, `late_student_ids[]`, `present_trial_enrollment_ids[]`.
  - `AttendanceCorrected` payload: `attendance_record_id`, `revision_version`, `lesson_id`, `student_id`, `enrollment_id`, `previous_status`, `new_status`, `override_reason`, `actor_staff_id`, `requires_trial_compensation_review` (`boolean` — 2-trial dars `PRESENT`/`LATE` holatidan `ADMIN_OVERRIDE` orqali `ABSENT` ga tuzatilganda `true`).

---

<a id="evt-outbox-lease-retry-dlq"></a>
## 3. Outbox Worker Lease Fencing, Per-Aggregate Ordering, Consumer Dedup, Retry/Backoff va DLQ (`S2F04`, `T02.04`, `T13.01`)

### 3.1. Predecessor Gate va Monoton `lease_token` bilan Lease Olish (`S2F04`)
Oddiy `FOR UPDATE SKIP LOCKED` so‘rovi ayni bir agregatning `v1` va `v2` hodisalarini ikki xil workerga bir vaqtda berib yuborishi mumkin (`S2F04`). Buning oldini olish uchun lease so‘rovi:
1. **`NOT EXISTS` predecessor gate** orqali ayni `(center_id, aggregate_type, aggregate_id)` bo‘yicha kichikroq `aggregate_version` hali `PENDING`, `LEASED` yoki `DEAD_LETTER` bo‘lsa, navbatdagi versiyani band qilmaydi;
2. Har safar lease olinganda **`lease_token = lease_token + 1`** monoton fencing tokenini oshiradi:

```sql
UPDATE outbox_events AS target
   SET status = 'LEASED',
       leased_by_worker = :worker_id,
       lease_until = NOW() + INTERVAL '30 seconds',
       attempt_count = target.attempt_count + 1,
       lease_token = target.lease_token + 1,
       updated_at = NOW()
 WHERE target.id IN (
   SELECT candidate.id
     FROM outbox_events AS candidate
    WHERE candidate.status IN ('PENDING', 'LEASED')
      AND (candidate.lease_until IS NULL OR candidate.lease_until < NOW())
      AND candidate.next_attempt_at <= NOW()
      AND NOT EXISTS (
        SELECT 1
          FROM outbox_events AS prev
         WHERE prev.center_id = candidate.center_id
           AND prev.aggregate_type = candidate.aggregate_type
           AND prev.aggregate_id = candidate.aggregate_id
           AND prev.aggregate_version < candidate.aggregate_version
           AND prev.status IN ('PENDING', 'LEASED', 'DEAD_LETTER')
      )
    ORDER BY candidate.occurred_at_utc ASC, candidate.aggregate_version ASC, candidate.id ASC
    LIMIT 25
    FOR UPDATE SKIP LOCKED
 )
RETURNING target.*;
```

### 3.2. Atomik Consumer Effect + Receipt va Late ACK Fencing (`S2F04`)
1. **Ichki DB Consumer Atomik Tranzaksiyasi:**
   - Worker hodisani olgach (`worker_lease_token = target.lease_token`), har bir ichki DB consumer uchun bitta PostgreSQL tranzaksiyasini boshlaydi:
     1. `SELECT id FROM outbox_events WHERE id = :event_id AND status = 'LEASED' AND lease_token = :worker_lease_token FOR UPDATE;` — agar worker sekin ishlab 30 soniyalik lease muddati o‘tib ketgan va boshqa worker `lease_token` ni `2` ga oshirgan bo‘lsa, `0` qator qaytadi va kechikkan worker tranzaksiyani **darhol `ROLLBACK`** qiladi (`Late ACK Fencing`);
     2. `INSERT INTO outbox_consumer_receipts (id, center_id, outbox_event_id, consumer_name, consumer_receipt_key, fencing_lease_token, effect_summary_json, processed_at_utc) VALUES (...) ON CONFLICT (center_id, consumer_name, outbox_event_id) DO NOTHING RETURNING id;` — agar ushbu consumer avvalgi urinishda bajarilgan bo‘lsa (`0` qator qaytsa), domen o‘zgarishi qayta bajarilmaydi;
     3. Domen o‘zgarishini (`Invoice`, `CreditNote`, `CreditNoteApplication`, `PromiseToPay` va h.k.) bajaradi va tranzaksiyani `COMMIT` qiladi.
2. **Fanout Qabul Qiluvchilar Progressi (`notification_deliveries`):**
   - `AttendanceSubmitted` kabi hodisa bir nechta ota-onaga (`N` ta `absent_student_ids`) xabar yuborishni talab qilganda, avval har bir qabul qiluvchi uchun `notification_deliveries (outbox_event_id, recipient_type, recipient_id)` yozuvi `QUEUED` holatida yaratiladi (`ON CONFLICT DO NOTHING`).
   - Worker faqat `delivery_status IN ('QUEUED', 'RETRY_429') AND next_attempt_at <= NOW()` qatorlarni yuboradi; allaqachon `API_ACCEPTED`, `SKIPPED_UNLINKED` yoki `FAILED_403_BLOCKED` bo‘lgan qabul qiluvchilarga retryda qayta xabar ketmaydi (`S2F04`).
   - Barcha ichki consumerlarning `outbox_consumer_receipts` yozuvlari va barcha `notification_deliveries` qatorlari yakuniy holatga (`API_ACCEPTED`, `SKIPPED_UNLINKED`, `FAILED_403_BLOCKED`, `DEAD_LETTER`) yetgandagina `outbox_events` qatori `WHERE id = :event_id AND lease_token = :worker_lease_token` sharti bilan `COMPLETED` qilinadi.

### 3.3. Bounded Exponential Backoff, Poison Handling va Retention (`T02.04`, `T13.01`)
- Tashqi xato (`network timeout`, `5xx`) bo‘lganda `attempt_count <= 8` gacha eksponensial backoff qo‘llanadi: `delay = min(3600, 2 ^ attempt_count * 5)` soniya (`5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s`).
- Telegram `429 Too Many Requests` qaytganda `next_attempt_at = NOW() + retry_after_seconds` ga o‘rnatiladi (`D09`, `T14.04`).
- Telegram `403 Forbidden (bot was blocked by the user)` qaytganda retry qilinmaydi: `guardian_telegram_links.status = 'BOT_BLOCKED_403'` ga o‘tkaziladi, `notification_deliveries.delivery_status = 'FAILED_403_BLOCKED'` yoziladi va talaba profilida sariq belgi ("Bot ulanmagan") hamda Admin call-list yangilanadi (`R18`, `T14.04`).
- `attempt_count > 8` bo‘lgan poison hodisalar `status = 'DEAD_LETTER'` ga o‘tkaziladi; bitta agregatning `DEAD_LETTER` hodisasi faqat o‘sha `(aggregate_type, aggregate_id)` ning keyingi versiyalarini to‘xtatadi, boshqa talabalar va guruhlar hodisalari esa hech qanday to‘siqsiz ishlayveradi.
- `COMPLETED` outbox hodisalari operatsion indeks tezligi uchun `90 kun` faol jadvalda saqlanib, so‘ng arxiv bo‘limiga o‘tkaziladi; `outbox_consumer_receipts`, `notification_deliveries` va `audit_logs` esa moliyaviy/huquqiy retention siyosati (`D19`) bo‘yicha saqlanadi.

---

<a id="evt-at-least-once-restore-readonly"></a>
## 4. Tashqi Telegram `At-Least-Once` Chegarasi, Unlink, Restore va `Read-Only` Siyosati

1. **Arxitektura Dizayni vs Runtime Isbot Chegarasi (`S2F04`, `03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`, `T02.04`, `T13.01`):**
   - Yuqoridagi `outbox_consumer_receipts` + `lease_token` fencing modeli ichki DB consumerlar uchun idempotent (`effectively-once` DB state effect) dizayn kontraktini beradi; biroq ushbu bosqichda (Stage 02/03) u **hujjat va sxema darajasida loyihalashtirilgan bo‘lib, real PostgreSQL poyga/runtime isboti Stage 13–14 da bajariladi (`NOT_RUN until S13/S14`)**.
   - Tashqi Telegram Bot API esa lokal DB tranzaksiyasiga kirmaydi: agar worker `sendMessage` muvaffaqiyatli chaqirilgandan keyin, lekin mahalliy DB da `notification_deliveries.delivery_status = 'API_ACCEPTED'` (va `lease_token` tekshiruvi) commit bo‘lishidan oldin yiqilsa (`crash after external send`), lease tugagach xabar Telegramga 2-marta ketishi mumkin (`at-least-once`). Tizim har bir xabarda `outbox_event_id` / `receipt_number` ni saqlaydi; shuningdek `API_ACCEPTED` holati ota-ona xabarni o‘qidi (`READ`) degan ma’noni anglatmaydi (`T14.04`, `T14.05`).
2. **Yuborish Oldidan Jonli `Active Link` va `Debt > 0` Tekshiruvi (`05_DOMAIN_RULES.md`, `T13.02`, `T14.02`):**
   - Worker `PaymentRecorded`, `AttendanceSubmitted` yoki `PromiseDue` xabarini Telegramga yuborishdan **aynan oldin** bazadan:
     1. `guardian_telegram_links.status == 'ACTIVE'` ekanini (agar ota-ona unlink bo‘lgan bo‘lsa `SKIPPED_UNLINKED` qilinadi — `B16`);
     2. `PromiseDue` uchun `invoices.remaining_debt_uzs > 0` ekanini (to‘lab bo‘lingan qarzga eslatma ketmaydi — `T13.02`) qayta tekshiradi.
3. **Zaxiradan Tiklashda (`Restore`) `BOT_OUTBOUND_ENABLED = false` Qoidasi (`B14`, `BR-17`, `T21.02`):**
   - Tungi zaxiradan tiklangan bazada kechagi `PENDING`/`LEASED` outbox hodisalari bo‘lishi mumkin. Restore muhitida tizim `BOT_OUTBOUND_ENABLED = false` flagi bilan ishga tushadi; admin/operator `reconcile_restored_outbox` buyrug‘i bilan eski hodisalarni `SUPERSEDED_BY_RESTORE` qilib belgilagandan keyingina outbound jo‘natish yoqiladi.
4. **`Read-Only` Litsenziya Rejimida Tizim ACK vs Biznes Mutatsiya Farqi (`B13`, `BR-15`, `T19.03`):**
   - Markaz `READ_ONLY` rejimiga o‘tkazilganda yangi biznes mutatsiyalari (`PaymentRecorded`, `AttendanceSubmitted`, `DiscountApproved`, `FreezeCreditIssued`) yaratilishi API/Worker tomonidan bloklanadi; ammo litsenziya holati yangilanishi (`LicenseStateChanged`), tungi backup telemetriyasi va Read-Only ga o‘tishdan oldin commit bo‘lgan tizim audit hodisalari (`System Allowlist` — `D17`, `D23`) qayta ishlanaveradi.
