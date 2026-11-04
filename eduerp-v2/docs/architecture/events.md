# EduERP v2.0 — Transactional Outbox Hodisalar Katalogi, Lease/Retry/DLQ va Telegram Yetkazib Berish Semantikasi (`docs/architecture/events.md`)

<a id="evt-meta"></a>
- **Task / Step ID:** `S01-FIX-S02-FULL-D` / Step `02.04` (`T02.04`)
- **Base Commit:** `dbd2a673cf70f915d2812f10d120e496167c5ae7`
- **Asosiy manbalar:** `planning/03_ARCHITECTURE.md`, `planning/05_DOMAIN_RULES.md`, `docs/spec/business-rules.md` (`BR-03`–`BR-17`, `C03`, `C04`), `docs/architecture/data-model.md` (`outbox_events`, `notification_deliveries`), `docs/architecture/openapi.yaml`.
- **Hujjat maqomi:** `IN_REVIEW` (Stage 02 hodisalar va asinxron navbat spetsifikatsiyasi; bajariladigan worker kodi Stage 13–14 da yoziladi).

---

<a id="evt-envelope-and-outbox-tx"></a>
## 1. Umumiy Outbox Konverti (`Event Envelope`) va Transactional Outbox Qoidasi (`T02.04`)

### 1.1. Atomik Producer Tranzaksiyasi (`Producer DB Transaction`)
Hech bir servis tashqi tarmoqqa (Telegram Bot API ga) DB tranzaksiyasi ichida sinxron murojaat qilmaydi. Barcha domen hodisalari (`PaymentRecorded`, `AttendanceSubmitted` va b.) biznes o‘zgarishi (`Payment`, `AttendanceRecord`, `AuditLog`) bilan **aynan bitta PostgreSQL ACID tranzaksiyasida** `outbox_events` jadvaliga yoziladi (`03_ARCHITECTURE.md`, `T02.04`, `T04.03`, `T10.01`).

### 1.2. Standart Hodisa Konverti (`Canonical Event Envelope Schema`)
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
  "dedup_key": "center:11111111:PaymentRecorded:99999999:v1",
  "source_operation_id": "op-pay-20261112-001",
  "actor_id": "aaaa1111-bbbb-2222-cccc-333333333333",
  "actor_role": "ADMIN",
  "occurred_at_utc": "2026-11-12T06:15:30Z",
  "payload": {}
}
```
- **PII-Minimal Payload Qoidasi:** `payload_json` ichida ota-onaning ochiq telefon raqami (`phone_e164`) yoki parol/tokenlar saqlanmaydi; faqat `student_id`, `guardian_id`, `invoice_id`, `amount_uzs` (integer string, `scale=0` — `C03`) va status IDlari bo‘ladi. Worker xabar yuborishdan oldin `guardian_telegram_links` jadvalidan `status = 'ACTIVE'` chatni jonli tekshiradi (`05_DOMAIN_RULES.md`, `D18`).

---

<a id="evt-versioned-catalog"></a>
## 2. Versiyalangan Hodisalar Katalogi (`14 Domain Events`)

| № | Event Nomi (`event_name`) | Versiya | Producer Operatsiya (`openapi.yaml`) | Aggregate & `dedup_key` Qoidasi | Consumer(lar) va Vazifasi | PII-Minimal Payload Maydonlari |
| :-: | :--- | :---: | :--- | :--- | :--- | :--- |
| <a id="evt-PaymentRecorded"></a>**1** | **`PaymentRecorded`** | `v1` | `recordPaymentWithRequiredPromise` | `Payment` (`v1`)<br>`dedup_key = "PaymentRecorded:{payment_id}"` | `TelegramNotificationConsumer`: ota-onaga ichki elektron kvitansiya (`receipt_number`, `amount_uzs`, `remaining_debt_uzs`, `next_due_date`) yuborish (`BR-05`, `D13`, `T02.04`). | `payment_id`, `receipt_id`, `receipt_number`, `student_id`, `amount_uzs`, `currency:"UZS"`, `payment_method`, `allocated_total_uzs`, `unapplied_credit_uzs`, `remaining_debt_uzs`, `promise_id`, `promise_date` |
| <a id="evt-AllocationAdjusted"></a>**2** | **`AllocationAdjusted`** | `v1` | `recordPaymentWithRequiredPromise`, `issueBillingCycleInvoice`, `decidePaymentReversalOrRefund` | `Invoice` (`vN`)<br>`dedup_key = "AllocationAdjusted:{invoice_id}:v{version}"` | `PromiseLifecycleConsumer`: agar `remaining_debt_uzs == "0"` bo‘lsa, ochiq `PromiseToPay` ni `FULFILLED`/`CANCELLED` qilish (`T11.03`); `ReportProjectionConsumer`. | `invoice_id`, `enrollment_id`, `student_id`, `allocation_id`, `delta_allocated_uzs`, `new_remaining_debt_uzs`, `invoice_status` |
| <a id="evt-RefundRecorded"></a>**3** | **`RefundRecorded`** | `v1` | `requestPaymentReversalOrRefund`, `decidePaymentReversalOrRefund` | `ReversalOrRefund` (`v1`..`v2`)<br>`dedup_key = "RefundRecorded:{reversal_id}:{status}"` | 1) `PENDING_DIRECTOR_APPROVAL` da: Rahbar Telegram botiga **darhol qizil ogohlantirish** va tasdiqlash tugmasini yuborish (`PDF p.3, 5`, `BR-07`);<br>2) `APPROVED_EXECUTED` da: `refund_method` (`CASH` vs `CARD/CLICK`) bo‘yicha smena va hisobotni yangilash (`C03`, `D22`). | `reversal_id`, `original_payment_id`, `student_id`, `kind`, `amount_uzs`, `refund_method`, `debt_effect_policy`, `status`, `requested_by_admin_id`, `approved_by_director_id` |
| <a id="evt-AttendanceSubmitted"></a>**4** | **`AttendanceSubmitted`** | `v1` | `submitLessonAttendance`, `syncOfflineAttendanceBatch` | `LessonOccurrence` (`vN`)<br>`dedup_key = "AttendanceSubmitted:{lesson_id}:op:{client_operation_uuid}"` | 1) `TrialConversionConsumer`: 2-distinct darsda `PRESENT`/`LATE` bo‘lgan `TRIAL` o‘quvchini faollashtirish (`BR-03`, `T02.04`, `T12.04`);<br>2) `TelegramNotificationConsumer`: `ABSENT` va `LATE` o‘quvchilarning faol ota-ona chatiga xabar yuborish. | `lesson_id`, `group_id`, `lesson_date`, `occurrence_seq`, `client_operation_uuid`, `submitted_by_staff_id`, `absent_student_ids[]`, `late_student_ids[]`, `present_trial_enrollment_ids[]` |
| <a id="evt-AttendanceCorrected"></a>**5** | **`AttendanceCorrected`** | `v1` | `submitLessonAttendance` (`source=ADMIN_OVERRIDE`) | `AttendanceRecord` (`vN`)<br>`dedup_key = "AttendanceCorrected:{attendance_record_id}:v{revision_version}"` | 1) `TrialCompensationConsumer`: agar 2-trial dars `PRESENT` dan `ABSENT` ga tuzatilgan bo‘lsa, `TrialCompensated` oqimini ishga tushirish (`C04`, `BR-03`);<br>2) `AuditAndNotificationConsumer`: yangi tuzatish xabarini yuborish (eski yuborilgan xabar o‘chirildi deb da’vo qilinmaydi — `T12.04`). | `attendance_record_id`, `revision_version`, `lesson_id`, `student_id`, `enrollment_id`, `previous_status`, `new_status`, `override_reason`, `actor_staff_id` |
| <a id="evt-TrialActivated"></a>**6** | **`TrialActivated`** | `v1` | `submitLessonAttendance` (via `TrialConversionPort`) | `TrialActivation` (`seq`)<br>`dedup_key = "TrialActivated:{enrollment_id}:seq:{trial_activation_seq}"` | `BillingInvoiceConsumer`: `first_trial_date` sanasidan boshlab `BillingCycle` va `Invoice` (`280,000` so‘m pro-rata yoki paket) yaratish (`BR-03`, `C04`, `T08.03`). | `trial_activation_id`, `enrollment_id`, `student_id`, `group_id`, `trial_activation_seq`, `first_trial_lesson_id`, `first_trial_date`, `second_trigger_lesson_id`, `generated_invoice_id` |
| <a id="evt-TrialCompensated"></a>**7** | **`TrialCompensated`** | `v1` | `submitLessonAttendance` (`ADMIN_OVERRIDE` on 2nd trial) | `TrialActivation` (`seq`)<br>`dedup_key = "TrialCompensated:{enrollment_id}:seq:{trial_activation_seq}"` | `BillingCompensationConsumer`: xato aktivlashgan invoice’ga to‘liq `CreditNote (TRIAL_CORRECTION_VOID)` yozib `VOID_COMPENSATED` qilish va `Enrollment.status = 'TRIAL'` ga qaytarish; keyingi haqiqiy darsda `seq + 1` bilan qayta aktivlashishga yo‘l ochish (`C04`, `CASE-06`). | `trial_activation_id`, `enrollment_id`, `trial_activation_seq`, `voided_invoice_id`, `compensation_credit_note_id`, `compensated_amount_uzs`, `reason` |
| <a id="evt-DiscountApproved"></a>**8** | **`DiscountApproved`** | `v1` | `decideDiscountOrGrantRequest`, `executeDirectorApprovalCallbackFromBot` | `DiscountRequest` (`vN`)<br>`dedup_key = "DiscountApproved:{discount_request_id}"` | `BillingAdjustmentConsumer`: Rahbar tasdiqlagan 50% chegirma, oilaviy chegirma yoki 100% Grant (`net_charge = 0`) ni `Invoice` ga qo‘llash (`BR-04`, `D14`, `T09.02`). | `discount_request_id`, `approval_id`, `enrollment_id`, `target_invoice_id`, `discount_kind`, `applied_amount_uzs`, `new_effective_net_charge_uzs`, `director_staff_id`, `approval_channel` |
| <a id="evt-FreezeCreditIssued"></a>**9** | **`FreezeCreditIssued`** | `v1` | `createFreezeAndIssueCreditNote` | `FreezeRecord` (`v1`)<br>`dedup_key = "FreezeCreditIssued:{freeze_record_id}"` | `BillingCreditConsumer`: kesishgan darslarni dedup qilib, `invoice.effective_net_charge_uzs` asosida (`C03` cap bilan) keyingi `BillingCycle` uchun `CreditNote` biriktirish (`BR-08`, `D14`, `T09.03`). | `freeze_record_id`, `credit_note_id`, `enrollment_id`, `source_invoice_id`, `distinct_frozen_lessons`, `basis_net_charge_uzs`, `calculated_credit_uzs` |
| <a id="evt-PromiseDue"></a>**10** | **`PromiseDue`** | `v1` | `PromiseReminderJob` (`09:00` center local time) | `PromiseToPay` (`vN`)<br>`dedup_key = "PromiseDue:{promise_id}:{promise_date}"` | `TelegramNotificationConsumer` & `AdminTaskConsumer`: soat `09:00` da `remaining_debt_uzs > 0` ekani qayta tekshirilgach, ota-ona Telegram botiga va Adminga (`OPEN_CHANNEL_02`) muloyim eslatma yuborish (`BR-05`, `T13.02`). | `promise_id`, `student_id`, `invoice_id`, `promise_date`, `verified_remaining_debt_uzs` |
| <a id="evt-PromiseFulfilled"></a>**11** | **`PromiseFulfilled`** | `v1` | `recordPaymentWithRequiredPromise`, `decideDiscountOrGrantRequest` | `PromiseToPay` (`vN`)<br>`dedup_key = "PromiseFulfilled:{promise_id}"` | `SchedulerCancelConsumer`: qarz va’da sanasidan oldin `0` bo‘lganda `09:00` eslatmasini bekor qilish (`BR-05`, `CASE-22`, `T11.03`, `T13.02`). | `promise_id`, `student_id`, `invoice_id`, `fulfilled_by_payment_id`, `fulfilled_at_utc` |
| <a id="evt-TeacherPingDue"></a>**12** | **`TeacherPingDue`** | `v1` | `TeacherPingAndEscalationJob` | `LessonOccurrence` (`vN`)<br>`dedup_key = "TeacherPingDue:{lesson_id}:{stage_20m_or_end}"` | `StaffAlertConsumer`: dars boshlanganidan `20 daqiqa` o‘tib davomat submit bo‘lmasa `pay_recipient_teacher_id` (asosiy yoki zamena o‘qituvchi) ga ping (`STAGE_20M_PING`), dars tugaganda esa Adminga escalation (`STAGE_END_ADMIN_ESCALATION`) yuborish (`BR-12`, `OPEN_CHANNEL_01`/`02`, `T13.03`). | `lesson_id`, `group_id`, `effective_teacher_id`, `escalation_stage`, `starts_at_utc`, `ends_at_utc` |
| <a id="evt-ShiftClosed"></a>**13** | **`ShiftClosed`** | `v1` | `closeCashShiftAndReconcile` | `CashShift` (`vN`)<br>`dedup_key = "ShiftClosed:{shift_id}"` | `TelegramNotificationConsumer`: Rahbarning Telegram botiga kechki kassa hisobotini (`opening_cash_uzs`, `cash_receipts_uzs`, `non_cash_receipts_uzs`, `cash_expenses_uzs`, `expected_closing_cash_uzs`, `discrepancy_uzs`) yuborish (`BR-09`, `T11.04`, `T14.03`). | `shift_id`, `shift_date`, `opening_cash_uzs`, `cash_receipts_uzs`, `non_cash_receipts_uzs`, `cash_refunds_uzs`, `non_cash_refunds_uzs`, `cash_expenses_uzs`, `expected_closing_cash_uzs`, `counted_closing_cash_uzs`, `discrepancy_uzs` |
| <a id="evt-GuardianLinkRevoked"></a>**14** | **`GuardianLinkRevoked`** | `v1` | `updateGuardianPhoneAndRevokeBot` | `GuardianTelegramLink` (`vN`)<br>`dedup_key = "GuardianLinkRevoked:{link_id}:v{version}"` | `BotSessionCacheConsumer`: ota-ona telefoni o‘zgarganda yoki vasiy unlink qilinganda eski `telegram_chat_id` keshini darhol tozalash va navbatdagi jo‘natilmagan xabarlarni `SKIPPED_UNLINKED` qilish (`D18`, `B16`, `T14.01`, `T14.02`). | `link_id`, `guardian_id`, `revoked_telegram_chat_id`, `revoke_reason`, `revoked_at_utc` |
| <a id="evt-LicenseStateChanged"></a>**15** | **`LicenseStateChanged`** | `v1` | `updateCenterLicenseKillSwitch` | `CenterLicense` (`vN`)<br>`dedup_key = "LicenseStateChanged:{center_id}:v{version}"` | `CenterLicenseGuardConsumer`: markaz API va Worker keshini yangilash; `READ_ONLY` ga o‘tganda yangi biznes mutatsiyalarini bloklash; `ACTIVE` ga qaytganda oflayn navbatni qayta tekshirish (`BR-15`, `D17`, `D23`, `T19.02`–`19.04`). | `center_id`, `center_slug`, `previous_mode`, `new_license_mode`, `valid_until_utc`, `grace_until_utc`, `signature_key_id` |

---

<a id="evt-outbox-lease-retry-dlq"></a>
## 3. Outbox Worker Lease, Tartib (`Ordering`), Retry/Backoff, DLQ va Retention Siyosati (`T02.04`, `T13.01`)

1. **Lease bilan olish (`Concurrent Worker Lease`):**
   - Worker har `500 ms` da quyidagi atomik so‘rov bilan batch (`<= 25` ta hodisa) oladi:
     ```sql
     UPDATE outbox_events
        SET status = 'LEASED',
            leased_by_worker = :worker_id,
            lease_until = NOW() + INTERVAL '30 seconds',
            attempt_count = attempt_count + 1
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE status IN ('PENDING', 'LEASED')
           AND (lease_until IS NULL OR lease_until < NOW())
           AND next_attempt_at <= NOW()
         ORDER BY occurred_at_utc ASC, id ASC
         LIMIT 25
         FOR UPDATE SKIP LOCKED
      )
     RETURNING *;
     ```
   - Agar worker DB commit/ack qilishdan oldin yiqilsa (`crash`), `30 soniya`dan keyin `lease_until < NOW()` bo‘lib, hodisa avtomatik boshqa/qayta yongan worker tomonidan olinadi (`T13.01`, `T13.05`).
2. **Tartib (`Ordering`) va Bo‘linish:**
   - Hodisalar `(aggregate_type, aggregate_id)` ichida `aggregate_version` tartibida qayta ishlanadi; bitta buzuq (`poison`) hodisa boshqa talabalar/guruhlar xabarlarini to‘sib qo‘ymaydi (`T13.01`).
3. **Bounded Exponential Backoff va Dead-Letter Queue (`DLQ`):**
   - Tashqi xato (`network timeout`, `5xx`) bo‘lganda `attempt_count <= 8` gacha eksponensial backoff qo‘llanadi: `delay = min(3600, 2 ^ attempt_count * 5)` soniya (`5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s`).
   - Telegram `429 Too Many Requests` qaytganda `next_attempt_at = NOW() + retry_after_seconds` ga o‘rnatiladi (`D09`, `T14.04`).
   - Telegram `403 Forbidden (bot was blocked by the user)` qaytganda retry qilinmaydi: `guardian_telegram_links.status = 'BOT_BLOCKED_403'` ga o‘tkaziladi, `notification_deliveries.delivery_status = 'FAILED_403_BLOCKED'` yoziladi va talaba profilida sariq belgi ("Bot ulanmagan") hamda Admin call-list yangilanadi (`R18`, `T14.04`).
   - `attempt_count > 8` bo‘lgan poison hodisalar `status = 'DEAD_LETTER'` ga o‘tkaziladi va monitoring ogohlantirishi (`T21.03`) chiqariladi.
4. **Retention va Schema Evolution (`T02.04`):**
   - `COMPLETED` outbox hodisalari operatsion indeks tezligi uchun `90 kun` faol jadvalda saqlanib, so‘ng arxiv bo‘limiga o‘tkaziladi; `notification_deliveries` va `audit_logs` esa moliyaviy/huquqiy retention siyosati (`D19`) bo‘yicha saqlanadi.
   - Har bir hodisada `schema_version` (`1, 2, ...`) bor; yangi maydonlar backward-compatible (`optional`) qo‘shiladi, buzuvchi o‘zgarish esa yangi `schema_version` bilan chiqariladi.

---

<a id="evt-at-least-once-restore-readonly"></a>
## 4. Tashqi Telegram `At-Least-Once` Chegarasi, Unlink, Restore va `Read-Only` Siyosati

1. **Tashqi API uchun `Exactly-Once` Kafolati Yo‘qligi (`At-Least-Once Boundary` — `03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`, `T02.04`, `T13.01`):**
   - Ichki DB consumerlar (`TrialConversionConsumer`, `BillingAdjustmentConsumer`) `dedup_key` va DB unique constraintlar tufayli **100% idempotent (`effectively-once` DB state effect)** ishlaydi.
   - Tashqi Telegram Bot API esa DB tranzaksiyasiga kirmaydi: agar worker `sendMessage` muvaffaqiyatli chaqirilgandan keyin, lekin mahalliy DB da `status = 'COMPLETED'` yozishdan oldin elektr/tarmoq uzilib yiqilsa (`crash after external send`), lease tugagach xabar Telegramga 2-marta ketishi mumkin. Tizim har bir xabarda `outbox_event_id` / `receipt_number` ni saqlaydi va ota-onaga ketgan xabar matnida kvitansiya/dars sanasi aniq ko‘rsatiladi; shuningdek `API_ACCEPTED` holati ota-ona xabarni o‘qidi (`READ`) degan ma’noni anglatmaydi (`T14.04`, `T14.05`).
2. **Yuborish Oldidan Jonli `Active Link` va `Debt > 0` Tekshiruvi (`05_DOMAIN_RULES.md`, `T13.02`, `T14.02`):**
   - Worker `PaymentRecorded`, `AttendanceSubmitted` yoki `PromiseDue` xabarini Telegramga yuborishdan **aynan oldin** bazadan:
     1. `guardian_telegram_links.status == 'ACTIVE'` ekanini (agar ota-ona unlink bo‘lgan bo‘lsa `SKIPPED_UNLINKED` qilinadi — `B16`);
     2. `PromiseDue` uchun `invoices.remaining_debt_uzs > 0` ekanini (to‘lab bo‘lingan qarzga eslatma ketmaydi — `T13.02`) qayta tekshiradi.
3. **Zaxiradan Tiklashda (`Restore`) `BOT_OUTBOUND_ENABLED = false` Qoidasi (`B14`, `BR-17`, `T21.02`):**
   - Tungi zaxiradan tiklangan bazada kechagi `PENDING`/`LEASED` outbox hodisalari bo‘lishi mumkin. Restore muhitida tizim `BOT_OUTBOUND_ENABLED = false` flagi bilan ishga tushadi; admin/operator `reconcile_restored_outbox` buyrug‘i bilan eski hodisalarni `SUPERSEDED_BY_RESTORE` qilib belgilagandan keyingina outbound jo‘natish yoqiladi.
4. **`Read-Only` Litsenziya Rejimida Tizim ACK vs Biznes Mutatsiya Farqi (`B13`, `BR-15`, `T19.03`):**
   - Markaz `READ_ONLY` rejimiga o‘tkazilganda yangi biznes mutatsiyalari (`PaymentRecorded`, `AttendanceSubmitted`, `DiscountApproved`, `FreezeCreditIssued`) yaratilishi API/Worker tomonidan bloklanadi; ammo litsenziya holati yangilanishi (`LicenseStateChanged`), tungi backup telemetriyasi va Read-Only ga o‘tishdan oldin commit bo‘lgan tizim audit hodisalari (`System Allowlist` — `D17`, `D23`) qayta ishlanaveradi.
