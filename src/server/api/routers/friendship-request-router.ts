import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { authGuard } from '@/server/trpc/middlewares/auth-guard'
import { procedure } from '@/server/trpc/procedures'
import { IdSchema } from '@/utils/server/base-schemas'
import { router } from '@/server/trpc/router'

const SendFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canSendFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = SendFriendshipRequestInputSchema.parse(rawInput)

    const existingFriendship = await ctx.db
      .selectFrom('friendships')
      .where('userId', '=', ctx.session.userId)
      .where('friendUserId', '=', friendUserId)
      .select('status')
      .executeTakeFirst()

    if (existingFriendship) {
      if (existingFriendship.status === FriendshipStatusSchema.Values['declined']) {
        await ctx.db
          .updateTable('friendships')
          .set({ status: FriendshipStatusSchema.Values['requested'] })
          .where('userId', '=', ctx.session.userId)
          .where('friendUserId', '=', friendUserId)
          .execute()
      } else if (existingFriendship.status === FriendshipStatusSchema.Values['requested']) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Friendship request already exists.',
        })
      }
    } else {
      await ctx.db
        .insertInto('friendships')
        .values({
          userId: ctx.session.userId,
          friendUserId,
          status: FriendshipStatusSchema.Values['requested'],
        })
        .execute()
    }

    return next({ ctx })
  }
)

const AnswerFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canAnswerFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = AnswerFriendshipRequestInputSchema.parse(rawInput)

    await ctx.db
      .selectFrom('friendships')
      .where('friendships.userId', '=', friendUserId)
      .where('friendships.friendUserId', '=', ctx.session.userId)
      .where(
        'friendships.status',
        '=',
        FriendshipStatusSchema.Values['requested']
      )
      .select('friendships.id')
      .limit(1)
      .executeTakeFirstOrThrow(() => {
        throw new TRPCError({
          code: 'BAD_REQUEST',
        })
      })

    return next({ ctx })
  }
)

export const friendshipRequestRouter = router({
  send: procedure
    .use(canSendFriendshipRequest)
    .input(SendFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      return { success: true }
    }),

  accept: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction().execute(async (t) => {
        await t
          .updateTable('friendships')
          .set({ status: FriendshipStatusSchema.Values['accepted'] })
          .where('userId', '=', input.friendUserId)
          .where('friendUserId', '=', ctx.session.userId)
          .execute()

        const reciprocalFriendship = await t
          .selectFrom('friendships')
          .where('userId', '=', ctx.session.userId)
          .where('friendUserId', '=', input.friendUserId)
          .select('status')
          .executeTakeFirst()

        if (reciprocalFriendship) {
          await t
            .updateTable('friendships')
            .set({ status: FriendshipStatusSchema.Values['accepted'] })
            .where('userId', '=', ctx.session.userId)
            .where('friendUserId', '=', input.friendUserId)
            .execute()
        } else {
          await t
            .insertInto('friendships')
            .values({
              userId: ctx.session.userId,
              friendUserId: input.friendUserId,
              status: FriendshipStatusSchema.Values['accepted'],
            })
            .execute()
        }
      })

      return { success: true }
    }),

  decline: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .updateTable('friendships')
        .set({ status: FriendshipStatusSchema.Values['declined'] })
        .where('userId', '=', input.friendUserId)
        .where('friendUserId', '=', ctx.session.userId)
        .execute()

      return { success: true }
    }),
})
