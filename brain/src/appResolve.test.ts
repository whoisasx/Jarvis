import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pickBestApp, scoreAppName} from './appResolve.js';

const APPS = [
  {label: 'YouTube', packageName: 'com.google.android.youtube'},
  {label: 'YT Music', packageName: 'com.google.android.apps.youtube.music'},
  {label: 'YouTube Music', packageName: 'com.google.android.apps.youtube.music'},
  {label: 'Chrome', packageName: 'com.android.chrome'},
  {label: 'Photos', packageName: 'com.google.android.apps.photos'},
  {label: 'Settings', packageName: 'com.android.settings'},
];

test('YouTube does not resolve to YT Music when YouTube exists', () => {
  const unique = [
    {label: 'YouTube', packageName: 'com.google.android.youtube'},
    {label: 'YT Music', packageName: 'com.google.android.apps.youtube.music'},
  ];
  const best = pickBestApp('YouTube', unique);
  assert.equal(best?.packageName, 'com.google.android.youtube');
  assert.equal(scoreAppName('YouTube', 'YT Music', 'com.google.android.apps.youtube.music'), 0);
});

test('YouTube Music and YT Music resolve to the music package', () => {
  assert.equal(pickBestApp('YouTube Music', APPS)?.packageName, 'com.google.android.apps.youtube.music');
  assert.equal(pickBestApp('YT Music', APPS)?.packageName, 'com.google.android.apps.youtube.music');
});

test('exact package query outranks every fuzzy label', () => {
  assert.equal(
    scoreAppName('com.google.android.youtube', 'YouTube', 'com.google.android.youtube'),
    100,
  );
  assert.ok(
    scoreAppName('com.google.android.youtube', 'YouTube', 'com.google.android.youtube') >
      scoreAppName('com.google.android.youtube', 'YT Music', 'com.google.android.apps.youtube.music'),
  );
});

test('YouTube does not fall back to Music when YouTube is absent', () => {
  const musicOnly = [{label: 'YT Music', packageName: 'com.google.android.apps.youtube.music'}];
  assert.equal(pickBestApp('YouTube', musicOnly), null);
});
