export function requireAdmin(req, res, next) {
  if (req.user?.admin !== true) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}
