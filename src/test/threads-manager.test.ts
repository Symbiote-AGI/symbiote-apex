import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadManager, type ThreadNotification } from '../threads/manager.js';

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-threads-'));
}

test('thread scopes restrict agent reads and mentions grant explicit access', () => {
  const workspace = temporaryWorkspace();
  const projectByAgent = new Map([['agent-a', 'project-a'], ['agent-b', 'project-a'], ['agent-c', 'project-b']]);
  const manager = new ThreadManager(
    workspace,
    id => projectByAgent.has(id),
    id => ['project-a', 'project-b'].includes(id),
    (id, projectId) => projectByAgent.get(id) === projectId,
  );
  try {
    const thread = manager.createThread({
      title: 'Review the release plan',
      scope: 'project',
      projectId: 'project-a',
      participants: ['agent-b'],
    }, { type: 'agent', id: 'agent-a', projectId: 'project-a' });
    assert.ok(manager.getThread(thread.id, { type: 'agent', id: 'agent-a', projectId: 'project-a' }));
    assert.ok(manager.getThread(thread.id, { type: 'agent', id: 'agent-b', projectId: 'project-a' }));
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }), undefined);
    assert.throws(() => manager.createThread({
      title: 'Cross-project invitation',
      scope: 'project',
      projectId: 'project-a',
      participants: ['agent-c'],
    }, { type: 'agent', id: 'agent-a', projectId: 'project-a' }), /only invite agents assigned to that project/);

    manager.postMessage(thread.id, { type: 'agent', id: 'agent-a', projectId: 'project-a' }, 'Please review the test report.', ['agent-b']);
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }), undefined);
    assert.equal(manager.listThreads({ type: 'agent', id: 'agent-b', projectId: 'project-a' }).length, 1);

    const crossProjectThread = manager.createThread({
      title: 'Partner project review',
      scope: 'selected',
      participants: ['agent-c'],
    }, { type: 'agent', id: 'agent-a', projectId: 'project-a' });
    assert.ok(manager.getThread(crossProjectThread.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }));

    const openThread = manager.createThread({ title: 'Open discussion', scope: 'open' }, { type: 'agent', id: 'agent-a' });
    assert.ok(manager.getThread(openThread.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }));
    assert.throws(() => manager.archiveThread(thread.id, { type: 'agent', id: 'agent-a' }), /Only the user can archive/);
    assert.equal(manager.archiveThread(thread.id, { type: 'user', id: 'user' }), true);
    assert.equal(manager.getThread(thread.id, { type: 'user', id: 'user' }), undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('spaces persist starter topics, assign reviewers, and schedule bounded review after participant posts', async () => {
  const workspace = temporaryWorkspace();
  const manager = new ThreadManager(workspace, id => ['agent-a', 'agent-b'].includes(id));
  try {
    const thread = manager.createThread({
      title: 'Release planning',
      topicTitle: 'Rollout risks',
      scope: 'selected',
      participants: ['agent-b'],
      reviewerAgentId: 'agent-a',
    }, { type: 'agent', id: 'agent-a' });
    const topic = thread.topics?.[0];
    assert.ok(topic);
    assert.equal(topic.title, 'Rollout risks');
    assert.equal(topic.reviewerAgentId, 'agent-a');

    const start = Date.now();
    const updated = manager.postMessage(thread.id, { type: 'user', id: 'user' }, 'Check the rollback plan.', [], 'message', topic.id);
    assert.equal(updated.posts[0].topicId, topic.id);
    const scheduledAt = updated.topics?.[0]?.reviewScheduledAt;
    assert.ok(scheduledAt);
    assert.ok(scheduledAt >= start + 60_000 && scheduledAt <= Date.now() + 90_000);

    const file = path.join(workspace, '.threads', 'threads.json');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      threads: Array<{ id: string; topics: Array<{ id: string; lastReviewedAt: number; reviewScheduledAt?: number }> }>;
    };
    const savedThread = persisted.threads.find(item => item.id === thread.id)!;
    const savedTopic = savedThread.topics.find(item => item.id === topic.id)!;
    savedTopic.lastReviewedAt = 0;
    savedTopic.reviewScheduledAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(persisted));

    let reviewed = false;
    manager.startSpaceReviews(async (space, reviewedTopic, newPosts) => {
      assert.equal(space.id, thread.id);
      assert.equal(reviewedTopic.id, topic.id);
      assert.equal(newPosts[0].body, 'Check the rollback plan.');
      reviewed = true;
    });
    const deadline = Date.now() + 2_000;
    while (!reviewed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reviewed, true);
    let after = manager.getThread(thread.id, { type: 'user', id: 'user' })?.topics?.[0];
    while ((!after || after.lastReviewedAt < updated.posts[0].createdAt) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      after = manager.getThread(thread.id, { type: 'user', id: 'user' })?.topics?.[0];
    }
    assert.ok(after);
    assert.ok(after.lastReviewedAt >= updated.posts[0].createdAt);
    assert.equal(after?.reviewScheduledAt, undefined);
  } finally {
    manager.stopSpaceReviews();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('user-help posts notify only as unread requests and support scoped reads and reactions', () => {
  const workspace = temporaryWorkspace();
  const projectByAgent = new Map([['agent-a', 'project-a'], ['agent-b', 'project-a'], ['agent-c', 'project-b']]);
  const manager = new ThreadManager(
    workspace,
    id => projectByAgent.has(id),
    id => ['project-a', 'project-b'].includes(id),
    (id, projectId) => projectByAgent.get(id) === projectId,
  );
  try {
    const requester = { type: 'agent' as const, id: 'agent-a', projectId: 'project-a' };
    const thread = manager.requestUserHelp(requester, 'Need a decision', 'The deployment target is not configured.');
    const post = thread.posts[0];
    assert.equal(thread.scope, 'project');
    assert.deepEqual(thread.participants.sort(), ['agent-a', 'main']);
    assert.equal(manager.listUnreadUserHelpRequests().length, 1);
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'agent-b', projectId: 'project-a' }), undefined);
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }), undefined);

    manager.markThreadRead(thread.id, { type: 'agent', id: 'agent-a', projectId: 'project-a' });
    assert.equal(manager.listUnreadUserHelpRequests().length, 1);
    const reacted = manager.reactToPost(thread.id, post.id, { type: 'agent', id: 'main', projectId: 'project-a' }, '✅');
    assert.deepEqual(reacted.posts[0].reactions, [{ emoji: '✅', actors: ['agent:main'] }]);
    assert.throws(() => manager.reactToPost(thread.id, post.id, { type: 'agent', id: 'agent-c', projectId: 'project-b' }, '👍'), /not an invited participant/);
    assert.throws(() => manager.reactToPost(thread.id, post.id, requester, 'not emoji'), /single emoji/);

    manager.markThreadRead(thread.id, { type: 'user', id: 'user' }, post.id);
    assert.equal(manager.listUnreadUserHelpRequests().length, 0);
    assert.throws(() => manager.requestUserHelp({ type: 'user', id: 'user' }, 'Invalid request', 'Only agents may ask.'), /Only agents/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('external contacts are token protected, scoped to their threads, and notify Symbiote once per post', async () => {
  const workspace = temporaryWorkspace();
  const manager = new ThreadManager(workspace, id => id === 'agent-a', id => id === 'project-a', (id, projectId) => id === 'agent-a' && projectId === 'project-a');
  try {
    const contact = manager.createContact('Build bot');
    assert.equal(manager.authenticateContact(contact.token)?.id, contact.id);
    assert.equal(manager.authenticateContact('not-a-valid-token'), undefined);
    const stored = fs.readFileSync(path.join(workspace, '.threads', 'threads.json'), 'utf8');
    assert.equal(stored.includes(contact.token), false);

    let handled = 0;
    let notification: ThreadNotification | undefined;
    manager.startNotifications(async item => {
      handled++;
      notification = item;
    });
    const thread = manager.externalCreateThread(contact, 'Build status', 'Build complete.\u0000 Results are ready.');
    assert.equal(thread.posts[0].body, 'Build complete. Results are ready.');
    assert.equal(manager.getExternalThread(contact.id, thread.id)?.posts.length, 1);
    assert.equal(manager.getExternalThread('another-contact', thread.id), undefined);
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'main' })?.posts.length, 1);
    assert.equal(manager.getThread(thread.id, { type: 'agent', id: 'agent-a' }), undefined);
    assert.equal(manager.getThread(thread.id, { type: 'user', id: 'user' })?.posts.length, 1);

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && manager.listThreads({ type: 'user', id: 'user' })[0]?.posts.length !== 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    while (Date.now() < deadline && !notification) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(handled, 1);
    assert.match(notification?.summary ?? '', /Build complete/);

    manager.postMessage(thread.id, { type: 'agent', id: 'main' }, 'Response from Symbiote.');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(handled, 1);
    manager.stopNotifications();
  } finally {
    manager.stopNotifications();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('external thread contacts can only post to invited threads and revoked tokens stop working', () => {
  const workspace = temporaryWorkspace();
  const manager = new ThreadManager(workspace);
  try {
    const contact = manager.createContact('Partner');
    const thread = manager.externalCreateThread(contact, 'External request', 'Please check the build.');
    const another = manager.createContact('Other partner');
    assert.throws(() => manager.externalPostMessage(another, thread.id, 'Unauthorized message'), /unavailable to this external contact/);
    assert.equal(manager.deleteContact(contact.id), true);
    assert.equal(manager.authenticateContact(contact.token), undefined);
    assert.throws(() => manager.externalPostMessage(contact, thread.id, 'Revoked'), /unavailable/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
