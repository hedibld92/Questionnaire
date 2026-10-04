'use strict';
// Questionnaire fields, checked against src/app.html by build.js and the tests.
const YN_FIELDS = ['accueil', 'info_etablissement', 'info_fonctionnement', 'info_specificite', 'info_soins', 'info_outils', 'info_equipe', 'info_planning', 'info_badge', 'tuteur', 'objectifs', 'bilan', 'objectifs_atteints', 'difficultes'];
const SAT_FIELDS = ['acquis_base', 'acquis_techniques', 'acquis_relationnels', 'acquis_educatifs'];
const TEXT_FIELDS = ['accueil_par_qui', 'objectifs_presentes', 'bilan_par_qui', 'competences', 'objectifs_pourquoi', 'difficultes_lesquelles', 'suggestions', 'plus_apprecie', 'moins_apprecie'];
const PRESENCE = ['cadre', 'tuteur', 'equipe', 'etudiant'];

const cleanText = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Format invalide.' };
  const out = {};
  out.formation = cleanText(body.formation, 80);
  out.annee = cleanText(body.annee, 40);
  const note = Number(body.note);
  if (!out.formation) return { error: 'La formation est obligatoire.' };
  if (!out.annee) return { error: 'L’année d’étude est obligatoire.' };
  if (!Number.isInteger(note) || note < 1 || note > 10) return { error: 'La note globale doit être comprise entre 1 et 10.' };
  out.note = note;
  for (const f of YN_FIELDS) out[f] = body[f] === 'oui' || body[f] === 'non' ? body[f] : null;
  for (const f of SAT_FIELDS) out[f] = ['tres', 'sat', 'peu'].includes(body[f]) ? body[f] : null;
  for (const f of TEXT_FIELDS) { const t = cleanText(body[f], 1500); if (t) out[f] = t; }
  out.eval_presence = Array.isArray(body.eval_presence) ? PRESENCE.filter(p => body.eval_presence.includes(p)) : [];
  return { value: out };
}

module.exports = { YN_FIELDS, SAT_FIELDS, TEXT_FIELDS, PRESENCE, validate };
