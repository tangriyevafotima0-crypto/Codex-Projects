# Moliya va sinxronizatsiya kontrakti
**Quyidagilar implementatsiya sharti/taklifidir; tasdiqlanmagan biznes siyosati kodga yashirin default bo‘lib kirmaydi.**

## Ma’lumot modeli
Student identity → bir yoki ko‘p Enrollment → Group/Course. GuardianStudent ko‘p-ko‘p. LessonOccurrence alohida ID; assignment effective va substitute snapshot. InvoiceLine price/policy/version snapshot; Payment → Allocation; ortiqcha pul UnappliedCredit. CreditNote (freeze/discount adjustment) va cash Refund bir narsa emas. CashShift va Expense alohida. Money movement append-only; editable profil version bilan.

## Hisoblash tartibi
Policy snapshot → davr/darslar → base charge → prorata → tasdiqlangan discount/credit → rounding → invoice. Discount stacking, rounding bosqichi va freeze transfer markaz bilan tasdiqlanadi. Old invoice qayta hisoblanib yashirin o‘zgarmaydi: credit/debit adjustment. Bir xil adjustment sabab/event ID qayta ishlansa ikkinchi effect yo‘q.

Trial: birinchi attended trial dars qarz bermaydi; ikkinchi distinct attended dars activation command beradi, dastlabki trial sanasidan invoice hisoblanadi. Event correction yoki noto‘g‘ri attendance sababli activationni bekor qilish — sababli adjustment siyosati; tarixni o‘chirish emas. Trial no-show threshold S01da tanlanadi, S13 follow-up yaratadi.

12-dars package: qaysi attendance status dars sarflashi, cancelled lesson va freeze ta’siri tasdiqlanadi. Calendar oy va rolling oy alohida. End-of-month (31→28/29) renewal qoidasi ochiq qaror.

Qarz = net invoice charge − allocation − applied credit. Overpayment manfiy qarz emas, unapplied credit. Refund cash outflow; invoice qarzini qayta ochishi policyga bog‘liq. Payment+required promise bir transaction command. Late payment/eslatma poygasida worker yuborishdan oldin debtni qayta o‘qiydi.

Smena = opening cash + cash receipts − cash refunds − cash expenses ± audited cash adjustments. Card/transfer alohida. Closed shift va payroll snapshoti o‘zgarmaydi; keyingi davr correction alohida.

## Xavfli poygalar va javob
| Holat | Kontrakt |
|---|---|
| Ikki Admin bitta paymentni retry qiladi | idempotency actor/center/operation scope, body hash mismatch409 |
| Ikki Director bir requestni approve qiladi | status/version atomic compare, effect unique |
| Excel previewdan keyin mobile write | commit expected versionni qayta tekshiradi, conflict |
| Offline Teacher vakolati olib tashlangan | sync server hozirgi permissionni tekshiradi; local write authoritative emas |
| Parent unlink va pending notification | send oldidan recipient link active tekshiriladi |
| Worker senddan keyin crash | Telegram external exactly-once yo‘q; duplicate ehtimoli va event ID kuzatiladi |
| Restore eski outboxni qaytaradi | outbound disabled restore, reconciliation va replay qarori |
| License renew va offline queue | permission/version/policy revalidation, blind replay yo‘q |
| Center timezone o‘zgardi | old financial periods tarixiy timezone bilan; future schedule yangi policy |

## Baza va API cheklovi
Ledger runtime roli UPDATE/DELETE qilmaydi; migrator alohida. Admin root access tahdidiga 100% himoya da’vosi yo‘q. DB tx audit/outbox bilan atomik. Balance cache bo‘lsa qayta tiklanadigan projection, source of truth emas. Read-only allowlist system ack/health va haqiqiy business writesni ajratadi. Financial retention va guardian data deletion talablari S01da belgilanadi; cascade delete moliyani buzmaydi.
