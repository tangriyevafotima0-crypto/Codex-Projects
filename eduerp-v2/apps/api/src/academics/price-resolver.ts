import { DatabaseService } from '../database/database.service';
import { TransactionContext } from '../database/transaction';

export type PriceQueryExecutor =
  | Pick<DatabaseService, 'query'>
  | Pick<TransactionContext, 'query'>;

export interface CoursePriceHistoryItemDto {
  readonly id: string;
  readonly course_id: string;
  readonly group_id: string | null;
  readonly previous_fee_uzs: string;
  readonly new_fee_uzs: string;
  readonly effective_from: string;
  readonly changed_by_staff_id: string;
  readonly change_reason: string | null;
  readonly target_version_snapshot: number;
  readonly created_at_utc: string;
}

export interface ResolvedTariffState {
  readonly effective_fee_as_of_uzs: string;
  readonly as_of_date: string;
  readonly latest_scheduled_fee_uzs: string;
  readonly latest_effective_from: string | null;
  readonly history: readonly CoursePriceHistoryItemDto[];
}

export function formatPgCalendarDate(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

/**
 * I04 Pure Authoritative Tariff Resolver:
 * Given append-only `course_price_history` items scoped to a single entity (either course-level `group_id IS NULL`
 * or a specific group `group_id = <uuid>`), resolves the effective tariff as of `asOfDate` (`YYYY-MM-DD`):
 * 1. Entries are ordered deterministically by `(effective_from DESC, target_version_snapshot DESC, created_at_utc DESC, id DESC)`.
 *    If multiple updates target the same `effective_from` date, the higher `target_version_snapshot` (most recent update) wins.
 * 2. The active tariff as of `asOfDate` is the first entry with `effective_from <= asOfDate` (`activeEntry.new_fee_uzs`).
 * 3. If all history entries for this entity have `effective_from > asOfDate` (i.e. all recorded changes are still in the future
 *    relative to `asOfDate`), resolves to the earliest entry's `previous_fee_uzs` (the baseline fee before the first scheduled change).
 * 4. If zero history entries exist for this entity (e.g. a directly seeded row), resolves to `storedFallbackFeeUzs`.
 */
export function resolveEntityTariffFromHistory(
  items: readonly CoursePriceHistoryItemDto[],
  storedFallbackFeeUzs: string | bigint,
  asOfDate: string,
): ResolvedTariffState {
  const fallbackStr = BigInt(storedFallbackFeeUzs).toString(10);

  const sorted = [...items].sort((a, b) => {
    if (a.effective_from !== b.effective_from) {
      return a.effective_from > b.effective_from ? -1 : 1;
    }
    if (a.target_version_snapshot !== b.target_version_snapshot) {
      return b.target_version_snapshot - a.target_version_snapshot;
    }
    if (a.created_at_utc !== b.created_at_utc) {
      return a.created_at_utc > b.created_at_utc ? -1 : 1;
    }
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });

  const activeAsOfEntry = sorted.find((h) => h.effective_from <= asOfDate);
  const earliestEntry = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

  const effectiveFeeAsOfUzs = activeAsOfEntry
    ? activeAsOfEntry.new_fee_uzs
    : earliestEntry
      ? earliestEntry.previous_fee_uzs
      : fallbackStr;

  const latestScheduledEntry = sorted[0];
  const latestScheduledFeeUzs = latestScheduledEntry
    ? latestScheduledEntry.new_fee_uzs
    : fallbackStr;
  const latestEffectiveFrom = latestScheduledEntry ? latestScheduledEntry.effective_from : null;

  return Object.freeze({
    effective_fee_as_of_uzs: effectiveFeeAsOfUzs,
    as_of_date: asOfDate,
    latest_scheduled_fee_uzs: latestScheduledFeeUzs,
    latest_effective_from: latestEffectiveFrom,
    history: Object.freeze(sorted),
  });
}

function mapHistoryRowToDto(h: {
  id: string;
  course_id: string;
  group_id: string | null;
  previous_fee_uzs: string;
  new_fee_uzs: string;
  effective_from: unknown;
  changed_by_staff_id: string;
  change_reason: string | null;
  target_version_snapshot: number;
  created_at: Date | string;
}): CoursePriceHistoryItemDto {
  return Object.freeze({
    id: h.id,
    course_id: h.course_id,
    group_id: h.group_id ?? null,
    previous_fee_uzs: BigInt(h.previous_fee_uzs).toString(10),
    new_fee_uzs: BigInt(h.new_fee_uzs).toString(10),
    effective_from: formatPgCalendarDate(h.effective_from),
    changed_by_staff_id: h.changed_by_staff_id,
    change_reason: h.change_reason ?? null,
    target_version_snapshot: Number(h.target_version_snapshot ?? 1),
    created_at_utc: new Date(h.created_at).toISOString(),
  });
}

export async function resolveCourseTariffState(
  executor: PriceQueryExecutor,
  params: {
    readonly centerId: string;
    readonly courseId: string;
    readonly storedDefaultFeeUzs: string | bigint;
    readonly asOfDate: string;
  },
): Promise<{
  readonly courseTariff: ResolvedTariffState;
  readonly allCourseAndGroupHistory: readonly CoursePriceHistoryItemDto[];
}> {
  const histRes = await executor.query<{
    id: string;
    course_id: string;
    group_id: string | null;
    previous_fee_uzs: string;
    new_fee_uzs: string;
    effective_from: unknown;
    changed_by_staff_id: string;
    change_reason: string | null;
    target_version_snapshot: number;
    created_at: Date;
  }>(
    `SELECT "id"::text AS id,
            "course_id"::text AS course_id,
            "group_id"::text AS group_id,
            "previous_fee_uzs"::text AS previous_fee_uzs,
            "new_fee_uzs"::text AS new_fee_uzs,
            "effective_from",
            "changed_by_staff_id"::text AS changed_by_staff_id,
            "change_reason",
            "target_version_snapshot",
            "created_at"
       FROM "course_price_history"
      WHERE "center_id" = $1::uuid
        AND "course_id" = $2::uuid
      ORDER BY "effective_from" DESC, "target_version_snapshot" DESC, "created_at" DESC, "id" DESC`,
    [params.centerId, params.courseId],
  );

  const allItems = histRes.rows.map(mapHistoryRowToDto);
  // Course-level tariff resolution strictly filters to group_id === null so group-specific overrides never leak to course defaults!
  const courseLevelItems = allItems.filter((item) => item.group_id === null);
  const courseTariff = resolveEntityTariffFromHistory(
    courseLevelItems,
    params.storedDefaultFeeUzs,
    params.asOfDate,
  );

  return {
    courseTariff,
    allCourseAndGroupHistory: Object.freeze(allItems),
  };
}

export async function resolveGroupTariffState(
  executor: PriceQueryExecutor,
  params: {
    readonly centerId: string;
    readonly courseId: string;
    readonly groupId: string;
    readonly storedCurrentFeeUzs: string | bigint;
    readonly asOfDate: string;
  },
): Promise<ResolvedTariffState> {
  const histRes = await executor.query<{
    id: string;
    course_id: string;
    group_id: string | null;
    previous_fee_uzs: string;
    new_fee_uzs: string;
    effective_from: unknown;
    changed_by_staff_id: string;
    change_reason: string | null;
    target_version_snapshot: number;
    created_at: Date;
  }>(
    `SELECT "id"::text AS id,
            "course_id"::text AS course_id,
            "group_id"::text AS group_id,
            "previous_fee_uzs"::text AS previous_fee_uzs,
            "new_fee_uzs"::text AS new_fee_uzs,
            "effective_from",
            "changed_by_staff_id"::text AS changed_by_staff_id,
            "change_reason",
            "target_version_snapshot",
            "created_at"
       FROM "course_price_history"
      WHERE "center_id" = $1::uuid
        AND "course_id" = $2::uuid
        AND "group_id" = $3::uuid
      ORDER BY "effective_from" DESC, "target_version_snapshot" DESC, "created_at" DESC, "id" DESC`,
    [params.centerId, params.courseId, params.groupId],
  );

  const groupItems = histRes.rows.map(mapHistoryRowToDto);
  return resolveEntityTariffFromHistory(
    groupItems,
    params.storedCurrentFeeUzs,
    params.asOfDate,
  );
}
