import {
  ContentItem,
  YT_TITLE_MAX,
  contentIdForVideo,
  layout,
  metricKeys,
  type ContentItemInput,
  type VideoFormat,
} from '@darkrelay/core';
import { brandOf, outletOf, type PlannerDeps } from './planner';
import { listContent } from './upload';

/**
 * Adopting videos a channel already holds. A Short scheduled in YouTube
 * Studio is real — the platform is holding a release time for it — but
 * DarkRelay has no record of it, so the planner has nothing to re-place and
 * the schedule cannot show it. Adoption writes that record from what the
 * nightly analytics pull already stored, and nothing else: no upload, no
 * change on the platform, and no second copy of the video anywhere.
 *
 * An adopted record's media is the video's own URL rather than a bucket key,
 * which is both true and load-bearing: `isExternalMedia` is what keeps the
 * sweep from ever trying to upload a file that does not exist here.
 */

export interface AdoptCandidate {
  videoId: string;
  /** The content id this video would get, or already has. */
  id: string;
  title: string;
  kind: 'short' | 'video';
  /** The release time the platform is holding. */
  publishAt?: string;
  privacyStatus?: string;
  /** Why it was left alone, on the ones that were. */
  reason?: string;
}

export interface AdoptResult {
  brand: string;
  outlet: string;
  dryRun: boolean;
  /** Written, or — on a dry run — what would be written. */
  adopted: AdoptCandidate[];
  skipped: AdoptCandidate[];
}

export interface AdoptOptions {
  outlet?: string;
  /** Looks and reports, writes nothing. */
  dryRun?: boolean;
}

interface VideoRow {
  sk?: string;
  videoId?: string;
  title?: string;
  publishedAt?: string;
  format?: VideoFormat;
  durationSeconds?: number;
  privacyStatus?: string;
  /** The release time YouTube is holding for a scheduled video. */
  scheduledAt?: string;
}

/** A title YouTube accepted is almost always fine; the record insists anyway. */
const cleanTitle = (title: string, fallback: string) =>
  (title.replace(/[<>]/g, '').trim() || fallback).slice(0, YT_TITLE_MAX);

export async function adoptFromYouTube(
  deps: PlannerDeps,
  brandSlug: string,
  opts: AdoptOptions = {},
): Promise<AdoptResult> {
  const now = deps.now();
  const brand = await brandOf(deps, brandSlug);
  const outlet = outletOf(brand, opts.outlet);
  const dryRun = opts.dryRun ?? false;

  const existing = await listContent(deps.store, brandSlug);
  const tracked = new Map<string, string>();
  for (const item of existing) {
    for (const publication of item.publications) {
      if (publication.externalId) tracked.set(publication.externalId, item.id);
    }
  }
  const episodeVideos = await episodeVideoIds(deps, brand);

  const rows = (await deps.query(metricKeys.brandEpisodes(brandSlug))) as unknown as VideoRow[];
  const videos = rows.filter((r) => r.sk?.startsWith('V#') && r.videoId);

  const adopted: AdoptCandidate[] = [];
  const skipped: AdoptCandidate[] = [];

  for (const row of videos) {
    const videoId = row.videoId!;
    const title = cleanTitle(row.title ?? '', videoId);
    const kind = row.format === 'short' ? 'short' : 'video';
    const candidate: AdoptCandidate = {
      videoId,
      id: tracked.get(videoId) ?? contentIdForVideo(title, videoId),
      title,
      kind,
      publishAt: row.scheduledAt,
      privacyStatus: row.privacyStatus,
    };

    const already = tracked.get(videoId);
    if (already) {
      skipped.push({ ...candidate, reason: 'DarkRelay already tracks this one' });
      continue;
    }
    if (episodeVideos.has(videoId)) {
      skipped.push({ ...candidate, reason: 'it is an episode’s video, published by the feed' });
      continue;
    }
    if (!row.scheduledAt) {
      // Nothing to move: a public video's release already happened, and a
      // private one with no release time is not scheduled at all.
      skipped.push({
        ...candidate,
        reason:
          row.privacyStatus && row.privacyStatus !== 'public'
            ? `it is ${row.privacyStatus} with no release time set`
            : 'it is already out',
      });
      continue;
    }

    const input: ContentItemInput = {
      schemaVersion: 1,
      id: candidate.id,
      brand: brandSlug,
      kind,
      title,
      // Whatever the video says on the platform stays the truth: adoption
      // only claims the schedule, never the metadata.
      description: '',
      tags: [],
      media: { url: `https://www.youtube.com/watch?v=${videoId}` },
      publishAt: row.scheduledAt,
      publications: [
        {
          outlet: outlet.id,
          state: 'scheduled',
          externalId: videoId,
          publishAt: row.scheduledAt,
          // The platform already has this time, so a reschedule is only
          // needed once the slot here differs from it.
          sentPublishAt: row.scheduledAt,
          uploadedAt: row.publishedAt,
          warnings: [],
          updatedAt: now.toISOString(),
        },
      ],
      createdAt: row.publishedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const parsed = ContentItem.safeParse(input);
    if (!parsed.success) {
      skipped.push({
        ...candidate,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }

    if (!dryRun) {
      const written = await deps.store.createIfAbsent(
        layout.contentItem(brandSlug, parsed.data.id),
        JSON.stringify(parsed.data, null, 2),
        { contentType: 'application/json' },
      );
      if (!written) {
        skipped.push({ ...candidate, reason: 'a different video already has that id' });
        continue;
      }
    }
    adopted.push(candidate);
  }

  deps.log(dryRun ? 'Looked for videos to adopt' : 'Adopted videos from YouTube', {
    brand: brandSlug,
    outlet: outlet.id,
    adopted: adopted.length,
    skipped: skipped.length,
  });
  return { brand: brandSlug, outlet: outlet.id, dryRun, adopted, skipped };
}

/**
 * Video ids the feed already owns. An episode's YouTube video is published by
 * the publisher from the episode manifest, so adopting it as content would
 * give one video two owners.
 */
async function episodeVideoIds(
  deps: PlannerDeps,
  brand: Awaited<ReturnType<typeof brandOf>>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const shows = brand.outlets.filter((o) => o.kind === 'rss').map((o) => o.show);
  for (const show of shows) {
    for (const episode of await deps.episodes(show)) {
      if (episode.youtube?.videoId) ids.add(episode.youtube.videoId);
    }
  }
  return ids;
}
