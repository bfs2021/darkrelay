import {
  BrandConfig,
  ContentItem,
  accessFromGroups,
  contentIdForVideo,
  isExternalMedia,
  layout,
  metricKeys,
  type EpisodeManifest,
} from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptFromYouTube } from '../src/shorts/adopt';
import type { Query } from '../src/shorts/history';
import type { PlannerDeps } from '../src/shorts/planner';
import { route } from '../src/shorts/schedule-api';
import { MemoryStore } from './memory-store';

/**
 * Adopting what a channel already holds. The point of it: a Short scheduled
 * in YouTube Studio becomes something the scheduler can move, without the
 * video being uploaded again or touched on the platform.
 */

const NOW = new Date('2026-11-13T12:00:00Z');

const cc = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  name: 'Chaotic Commits',
  outlets: [
    { kind: 'rss', id: 'rss', show: 'cc' },
    { kind: 'youtube', id: 'youtube', connection: 'cc' },
  ],
});
/** A channel with no feed at all: the case this is mostly for. */
const dr = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'dr',
  name: 'Dr. Joanne Skiles',
  outlets: [{ kind: 'youtube', id: 'main', connection: 'dr' }],
});

let store: MemoryStore;
let table: Record<string, unknown>[];
let logs: string[];
let episodes: EpisodeManifest[];

const query: Query = async (pk) => table.filter((item) => item['pk'] === pk);

function deps(over: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    store,
    query,
    brands: async () => [cc, dr],
    episodes: async () => episodes,
    now: () => NOW,
    log: (m) => logs.push(m),
    ...over,
  };
}

/** One video as the nightly pull records it on the brand's meta partition. */
function seedVideo(brand: string, over: Record<string, unknown> = {}) {
  const row = {
    pk: metricKeys.brandEpisodes(brand),
    sk: metricKeys.videoMeta(String(over['videoId'] ?? 'yt-1')),
    videoId: 'yt-1',
    title: 'The bus factor nobody admits to',
    publishedAt: '2026-11-10T14:00:00Z',
    format: 'short',
    durationSeconds: 45,
    privacyStatus: 'private',
    scheduledAt: '2026-11-20T18:00:00Z',
    ...over,
  };
  table.push(row);
  return row;
}

beforeEach(() => {
  store = new MemoryStore();
  table = [];
  logs = [];
  episodes = [];
});

describe('what gets adopted', () => {
  it('writes a record the scheduler can move, pointing at the video on YouTube', async () => {
    seedVideo('dr');
    const result = await adoptFromYouTube(deps(), 'dr');
    expect(result).toMatchObject({ brand: 'dr', outlet: 'main', dryRun: false });
    expect(result.adopted).toEqual([
      {
        videoId: 'yt-1',
        id: contentIdForVideo('The bus factor nobody admits to', 'yt-1'),
        title: 'The bus factor nobody admits to',
        kind: 'short',
        publishAt: '2026-11-20T18:00:00Z',
        privacyStatus: 'private',
      },
    ]);

    const item = ContentItem.parse(store.json(layout.contentItem('dr', result.adopted[0]!.id)));
    expect(item.publishAt).toBe('2026-11-20T18:00:00Z');
    expect(item.media).toEqual({ url: 'https://www.youtube.com/watch?v=yt-1' });
    expect(isExternalMedia(item)).toBe(true);
    // Already on the platform at that time, so nothing needs sending until
    // the slot here differs from it.
    expect(item.publications[0]).toMatchObject({
      outlet: 'main',
      state: 'scheduled',
      externalId: 'yt-1',
      publishAt: '2026-11-20T18:00:00Z',
      sentPublishAt: '2026-11-20T18:00:00Z',
      uploadedAt: '2026-11-10T14:00:00Z',
    });
  });

  it('calls long-form a video and vertical a Short', async () => {
    seedVideo('dr', { videoId: 'yt-long', format: 'long', title: 'The whole episode' });
    const result = await adoptFromYouTube(deps(), 'dr');
    expect(result.adopted.map((a) => [a.videoId, a.kind])).toEqual([['yt-long', 'video']]);
  });

  it('is deterministic, so adopting twice adopts nothing new', async () => {
    seedVideo('dr');
    const first = await adoptFromYouTube(deps(), 'dr');
    const again = await adoptFromYouTube(deps(), 'dr');
    expect(first.adopted).toHaveLength(1);
    expect(again.adopted).toEqual([]);
    expect(again.skipped[0]).toMatchObject({ reason: 'DarkRelay already tracks this one' });
    expect(store.objects.size).toBe(1);
  });

  it('writes nothing on a dry run, but says what it would take', async () => {
    seedVideo('dr');
    const result = await adoptFromYouTube(deps(), 'dr', { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.adopted).toHaveLength(1);
    expect(store.objects.size).toBe(0);
  });
});

describe('what is left alone', () => {
  it('leaves a video that is already out', async () => {
    seedVideo('dr', {
      videoId: 'yt-public',
      privacyStatus: 'public',
      scheduledAt: undefined,
    });
    const result = await adoptFromYouTube(deps(), 'dr');
    expect(result.adopted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'it is already out' });
  });

  it('leaves a private video with no release time, and says which it is', async () => {
    seedVideo('dr', { videoId: 'yt-draft', privacyStatus: 'unlisted', scheduledAt: undefined });
    const result = await adoptFromYouTube(deps(), 'dr');
    expect(result.skipped[0]!.reason).toBe('it is unlisted with no release time set');
  });

  it('leaves an episode’s own video to the feed that publishes it', async () => {
    seedVideo('cc', { videoId: 'yt-ep' });
    episodes = [{ youtube: { videoId: 'yt-ep' } } as EpisodeManifest];
    const result = await adoptFromYouTube(deps(), 'cc');
    expect(result.adopted).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('episode');
  });

  it('leaves a video DarkRelay uploaded itself', async () => {
    seedVideo('dr', { videoId: 'yt-ours' });
    store.seed(
      layout.contentItem('dr', 'clip-aaaa1111'),
      JSON.stringify(
        ContentItem.parse({
          schemaVersion: 1,
          id: 'clip-aaaa1111',
          brand: 'dr',
          kind: 'short',
          title: 'Ours',
          media: { key: 'catalog/dr/content/clip-aaaa1111/clip.mp4' },
          publications: [
            { outlet: 'main', state: 'scheduled', externalId: 'yt-ours', warnings: [] },
          ],
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        }),
      ),
    );
    const result = await adoptFromYouTube(deps(), 'dr');
    expect(result.adopted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      id: 'clip-aaaa1111',
      reason: 'DarkRelay already tracks this one',
    });
  });

  it('takes only the Shorts when asked, and says what it passed over', async () => {
    seedVideo('dr', { videoId: 'yt-short', format: 'short', title: 'A clip' });
    seedVideo('dr', { videoId: 'yt-long', format: 'long', title: 'The whole episode' });
    const result = await adoptFromYouTube(deps(), 'dr', { kind: 'short' });
    expect(result.kind).toBe('short');
    expect(result.adopted.map((a) => a.videoId)).toEqual(['yt-short']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        videoId: 'yt-long',
        reason: 'it is a long-form video, and only Shorts were asked for',
      }),
    ]);
    expect(store.objects.size).toBe(1);
  });

  it('takes only the long-form when that is what was asked for', async () => {
    seedVideo('dr', { videoId: 'yt-short', format: 'short', title: 'A clip' });
    seedVideo('dr', { videoId: 'yt-long', format: 'long', title: 'The whole episode' });
    const result = await adoptFromYouTube(deps(), 'dr', { kind: 'video' });
    expect(result.adopted.map((a) => a.videoId)).toEqual(['yt-long']);
    expect(result.skipped[0]!.reason).toBe(
      'it is a Short, and only long-form videos were asked for',
    );
  });

  it('says a video is already out before saying it is the wrong kind', async () => {
    // The kind filter is about what would otherwise have been taken, so a
    // video with nothing to move still reads as having nothing to move.
    seedVideo('dr', {
      videoId: 'yt-old',
      format: 'long',
      privacyStatus: 'public',
      scheduledAt: undefined,
    });
    const result = await adoptFromYouTube(deps(), 'dr', { kind: 'short' });
    expect(result.skipped[0]!.reason).toBe('it is already out');
  });

  it('refuses a brand with no channel rather than inventing an outlet', async () => {
    const noChannel = BrandConfig.parse({
      schemaVersion: 1,
      slug: 'pod',
      name: 'Just A Podcast',
      outlets: [{ kind: 'rss', id: 'rss', show: 'pod' }],
    });
    await expect(
      adoptFromYouTube(deps({ brands: async () => [noChannel] }), 'pod'),
    ).rejects.toThrow(/no YouTube outlet/);
  });
});

describe('over the API', () => {
  const call = (body: unknown, groups = ['uploader:dr']) =>
    route(deps(), {
      method: 'POST',
      path: '/schedule/dr/import',
      params: {},
      body,
      access: accessFromGroups(groups),
    });

  it('needs the uploader role', async () => {
    seedVideo('dr');
    for (const groups of [[], ['viewer:dr'], ['uploader:cc']]) {
      expect((await call({ dryRun: true }, groups)).statusCode).toBe(403);
    }
    expect(store.objects.size).toBe(0);
  });

  it('looks on a dry run and writes without one', async () => {
    seedVideo('dr');
    const looked = await call({ dryRun: true });
    expect(looked.statusCode).toBe(200);
    expect(looked.body).toMatchObject({ dryRun: true, adopted: [{ videoId: 'yt-1' }] });
    expect(store.objects.size).toBe(0);

    const took = await call({});
    expect(took.statusCode).toBe(200);
    expect(took.body).toMatchObject({ dryRun: false, adopted: [{ videoId: 'yt-1' }] });
    expect(store.objects.size).toBe(1);
  });

  it('passes a kind through, and refuses one that is not a kind', async () => {
    seedVideo('dr', { videoId: 'yt-long', format: 'long' });
    const narrowed = await call({ dryRun: true, kind: 'short' });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.body).toMatchObject({ kind: 'short', adopted: [] });
    expect((await call({ dryRun: true, kind: 'episode' })).statusCode).toBe(400);
    expect((await call({ dryRun: true, kind: 'shorts' })).statusCode).toBe(400);
  });

  it('refuses a body it does not understand, and a GET', async () => {
    expect((await call({ nonsense: true })).statusCode).toBe(400);
    const read = await route(deps(), {
      method: 'GET',
      path: '/schedule/dr/import',
      params: {},
      access: accessFromGroups(['admin']),
    });
    expect(read.statusCode).toBe(405);
  });
});
