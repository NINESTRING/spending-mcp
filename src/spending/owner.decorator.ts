import { createParamDecorator, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { McpExecutionContext } from '@nestjs/mcp';

/** Whose spending a call reads and writes. */
export interface Owner {
  id: string;
}

/**
 * The owner a call is made for. Over HTTP, the subject of the verified access token; over stdio, where
 * there is no token, from the environment the local client starts the server with.
 */
export const CurrentOwner = createParamDecorator((_data: unknown, context: ExecutionContext): Owner => {
  const ctx = McpExecutionContext.create(context).getContext();
  const id = ctx.transport === 'stdio' ? process.env.SPENDING_OWNER : ctx.authInfo?.extra?.subject;
  if (typeof id !== 'string' || !id) {
    throw new ForbiddenException(
      ctx.transport === 'stdio' ? 'Set SPENDING_OWNER to the owner to work as' : 'The access token names no subject',
    );
  }
  return { id };
});
