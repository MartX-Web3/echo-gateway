import { PrivyClient } from '@privy-io/server-auth';
import type { Router, Request, Response } from 'express';

/**
 * POST /api/auth/privy
 * Verifies a Privy identity token and returns the user's embedded wallet address.
 * The frontend sends the identity token (privy-id-token) after successful login.
 */
export function registerAuthRoutes(router: Router, appId: string, appSecret: string): void {
  const privy = new PrivyClient(appId, appSecret);

  router.post('/auth/privy', async (req: Request, res: Response) => {
    try {
      const { identityToken, accessToken } = req.body as {
        identityToken?: string;
        accessToken?:  string;
      };

      if (!identityToken && !accessToken) {
        res.status(400).json({ error: 'identityToken or accessToken is required' });
        return;
      }

      let userId: string;
      let walletAddress: string | null = null;

      if (identityToken) {
        // Preferred: parse user info directly from the identity token (no API rate limits)
        const user = await privy.getUserFromIdToken(identityToken);
        userId = user.id;
        const wallet = user.linkedAccounts?.find(
          (a: { type?: string; walletClientType?: string; chainType?: string }) =>
            a.type === 'wallet' && a.walletClientType === 'privy' && a.chainType === 'ethereum',
        );
        walletAddress = (wallet as { address?: string } | undefined)?.address ?? null;
      } else {
        // Fallback: verify access token (subject to rate limits for user lookup)
        const claims = await privy.verifyAuthToken(accessToken!);
        userId = claims.userId;
        const user = await privy.getUserById(userId);
        const wallet = user.linkedAccounts?.find(
          (a: { type?: string; walletClientType?: string; chainType?: string }) =>
            a.type === 'wallet' && a.walletClientType === 'privy' && a.chainType === 'ethereum',
        );
        walletAddress = (wallet as { address?: string } | undefined)?.address ?? null;
      }

      res.json({ ok: true, userId, walletAddress });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Authentication failed' });
    }
  });
}
