// Symbiote — Builtin tool: threads management

import type { ThreadActor, ThreadManager, ThreadScope } from '../../threads/manager.js';
import type { ToolDefinition } from '../types.js';

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of agent IDs.`);
  }
  return value as string[];
}

export function createThreadsTool(
  manager: ThreadManager,
  resolveActor: (sessionId?: string) => ThreadActor,
): ToolDefinition {
  return {
    name: 'threads_manage',
    description: 'Create and participate in access-controlled collaboration spaces with named topics. Agents can only read spaces they created, were invited/mentioned in, or that are explicitly open. External-contact spaces are private to the user, Symbiote, and the invited contact. Topic discussions schedule a jittered review for their assigned agent when other participants add updates. Use request_user_help only when blocked and no reasonable independent path remains; it creates a private scoped request and notifies the user.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'create', 'create_topic', 'post', 'request_user_help', 'mark_read', 'react'], description: 'Space operation.' },
        threadId: { type: 'string', description: 'Thread ID for read or post.' },
        topicId: { type: 'string', description: 'Topic ID for a topic-specific post.' },
        postId: { type: 'string', description: 'Post ID for a read receipt or reaction.' },
        title: { type: 'string', description: 'Short title for a new thread.' },
        topicTitle: { type: 'string', description: 'Optional initial topic title when creating a space.' },
        reviewerAgentId: { type: 'string', description: 'Agent ID responsible for reviewing topic updates; defaults to the creating agent.' },
        scope: { type: 'string', enum: ['project', 'selected', 'open'], description: 'Project restricts invitations to that project; selected allows explicit cross-project participants; open is readable by all agents.' },
        projectId: { type: 'string', description: 'Required when scope is project.' },
        participantAgentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to invite to a project- or selected-scope thread.' },
        mentionAgentIds: { type: 'array', items: { type: 'string' }, description: 'Invite and notify these agents on this post. Mentioned agents gain access to the thread.' },
        body: { type: 'string', description: 'Plain-text message body.' },
        emoji: { type: 'string', description: 'A single emoji reaction.' },
      },
      required: ['action'],
    },
    idempotency: {
      class: 'external',
      externalSystem: 'threads_manager',
      irreversibleReason: 'Thread operations can create/modify discussion threads and send notifications to other agents, which cannot be automatically reversed.',
      idempotencyKey: (input) => {
        const action = String(input.action ?? '');
        const threadId = String(input.threadId ?? '');
        const postId = String(input.postId ?? '');
        const body = String(input.body ?? '');
        const title = String(input.title ?? '');
        return `threads_manage:${action}:${threadId}:${postId}:${title.slice(0, 32)}:${body.slice(0, 64)}`;
      },
    },
    execute: async (input, options) => {
      const actor = resolveActor(options?.sessionId);
      switch (input.action) {
        case 'list':
          return JSON.stringify(manager.listThreads(actor).map(thread => ({
            id: thread.id,
            title: thread.title,
            scope: thread.scope,
            projectId: thread.projectId,
            participantCount: thread.participants.length,
            postCount: thread.posts.length,
            topicCount: thread.topics?.length ?? 0,
            updatedAt: thread.updatedAt,
          })), null, 2);
        case 'read': {
          if (typeof input.threadId !== 'string' || !input.threadId.trim()) throw new Error('Reading a thread requires threadId.');
          const thread = manager.getThread(input.threadId.trim(), actor);
          if (!thread) throw new Error('Thread is unavailable or you are not an invited participant.');
          return JSON.stringify(thread, null, 2);
        }
        case 'create': {
          if (typeof input.title !== 'string' || typeof input.scope !== 'string') {
            throw new Error('Creating a thread requires title and scope.');
          }
          if (!['project', 'selected', 'open'].includes(input.scope)) {
            throw new Error('Agent-created threads support project, selected, or open scope.');
          }
          const thread = manager.createThread({
            title: input.title,
            scope: input.scope as ThreadScope,
            ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}),
            participants: stringArray(input.participantAgentIds, 'participantAgentIds'),
            ...(typeof input.topicTitle === 'string' ? { topicTitle: input.topicTitle } : {}),
            ...(typeof input.reviewerAgentId === 'string' ? { reviewerAgentId: input.reviewerAgentId } : {}),
          }, actor);
          return JSON.stringify(thread, null, 2);
        }
        case 'create_topic': {
          if (typeof input.threadId !== 'string' || !input.threadId.trim() || typeof input.title !== 'string') {
            throw new Error('Creating a topic requires threadId and title.');
          }
          const thread = manager.createTopic(input.threadId.trim(), actor, {
            title: input.title,
            ...(typeof input.reviewerAgentId === 'string' ? { reviewerAgentId: input.reviewerAgentId } : {}),
          });
          return JSON.stringify(thread.topics?.at(-1), null, 2);
        }
        case 'post': {
          if (typeof input.threadId !== 'string' || !input.threadId.trim() || typeof input.body !== 'string') {
            throw new Error('Posting requires threadId and body.');
          }
          const thread = manager.postMessage(
            input.threadId.trim(),
            actor,
            input.body,
            stringArray(input.mentionAgentIds, 'mentionAgentIds'),
            'message',
            typeof input.topicId === 'string' ? input.topicId : undefined,
          );
          return JSON.stringify({ threadId: thread.id, postCount: thread.posts.length, updatedAt: thread.updatedAt });
        }
        case 'request_user_help': {
          if (typeof input.title !== 'string' || typeof input.body !== 'string') {
            throw new Error('A short title and clear explanation are required to request user help.');
          }
          const thread = manager.requestUserHelp(actor, input.title, input.body);
          const post = thread.posts.at(-1);
          return JSON.stringify({ threadId: thread.id, postId: post?.id, notifiedUser: true });
        }
        case 'mark_read': {
          if (typeof input.threadId !== 'string' || !input.threadId.trim()) throw new Error('Marking a thread read requires threadId.');
          const thread = manager.markThreadRead(
            input.threadId.trim(),
            actor,
            typeof input.postId === 'string' ? input.postId : undefined,
          );
          return JSON.stringify({ threadId: thread.id, markedRead: input.postId ? input.postId : 'all posts' });
        }
        case 'react': {
          if (typeof input.threadId !== 'string' || !input.threadId.trim()
            || typeof input.postId !== 'string' || !input.postId.trim() || typeof input.emoji !== 'string') {
            throw new Error('Reacting requires threadId, postId, and an emoji.');
          }
          const thread = manager.reactToPost(input.threadId.trim(), input.postId.trim(), actor, input.emoji);
          return JSON.stringify({ threadId: thread.id, postId: input.postId, reactions: thread.posts.find(post => post.id === input.postId)?.reactions ?? [] });
        }
        default:
          throw new Error('Choose a valid thread action: list, read, create, post, request_user_help, mark_read, or react.');
      }
    },
  };
}