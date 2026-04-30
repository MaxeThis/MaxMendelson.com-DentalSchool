/* ScheduleMaxer — client logic.
 * Profiles live in Firestore (users/{sNumber}) so any device can sign in
 * with just an S#. Blocks live in Firestore (blocks/*) and are visible to
 * all signed-in users. A local cache of the current profile speeds things up. */

const BLOCK_TYPES = [
  'Oral Surgery',
  'Ortho',
  'Special Care',
  'Peds',
  'Emergency',
  'On-Call',
  'Screening',
  'Hospital',
  'Pan',
];

// axiUm / schedule code → display name. Match is case-insensitive; '@' is stripped.
// Variants below cover OCR mis-scans we've seen in the wild — see
// cleanDescription() for the prefix/garbage handling that runs before lookup.
const SCHEDULE_NAME_MAP = {
  'BLK-SURGERY': 'ORAL SURGERY BLOCK',
  'BLK-ORTHO':   'ORTHO BLOCK',
  'BLK-SPC&G':   'SPECIAL CARE BLOCK',
  'BLK-SPC3G':   'SPECIAL CARE BLOCK',  // OCR: & → 3
  'BLK-SPCAG':   'SPECIAL CARE BLOCK',  // OCR: & → a / A
  'BLK-5PC&G':   'SPECIAL CARE BLOCK',  // OCR: S → 5
  'BLK-5PC3G':   'SPECIAL CARE BLOCK',  // OCR: S → 5, & → 3
  'BLK-5PCAG':   'SPECIAL CARE BLOCK',  // OCR: S → 5, & → a
  'BLK-PEDS':    'PEDS BLOCK',
  'CLIN-EMERG':  'EMERGENCY BLOCK',
  'BLK-ONCALL':  'ON-CALL BLOCK',
  'BLKONCALL':   'ON-CALL BLOCK',       // OCR: missing dash (also matches GBLKONCALL via fuzzy includes())
  'BLK-SCR':     'SCREENING BLOCK',
  'BLK-HOSPITAL': 'HOSPITAL BLOCK',
  'BLK-PAN':     'PAN BLOCK',
};

// Display name → swap-listing block type.
const DESC_TO_TYPE = {
  'ORAL SURGERY BLOCK': 'Oral Surgery',
  'ORTHO BLOCK':        'Ortho',
  'SPECIAL CARE BLOCK': 'Special Care',
  'PEDS BLOCK':         'Peds',
  'EMERGENCY BLOCK':    'Emergency',
  'ON-CALL BLOCK':      'On-Call',
  'SCREENING BLOCK':    'Screening',
  'HOSPITAL BLOCK':     'Hospital',
  'PAN BLOCK':          'Pan',
};

const PROFILE_KEY = 'umsod_be_profile_v1';
const SCHEDULE_KEY_PREFIX = 'umsod_be_schedule_v1:';

/* Assist board: per-procedure assist requests. Posts go live for everyone at
 * 8 AM the day before the appointment (Endo: a full week before). The wire
 * format and Firestore rules accept the union of legal time slots; the client
 * is responsible for honoring the day-of-week rule (1 PM Tue–Fri, 2 PM Mon). */
const ASSIST_PROCEDURES = ['Endo', 'Fixed', 'Remo', 'Operative'];
const ASSIST_TIME_DEFAULT = ['7am', '9:30am', '1pm', '4pm'];
const ASSIST_TIME_MONDAY  = ['7am', '9:30am', '2pm', '4pm'];
const ASSIST_TIME_ALL     = ['7am', '9:30am', '1pm', '2pm', '4pm'];
const ASSIST_TIME_LABEL = {
  '7am':    '7:00 AM',
  '9:30am': '9:30 AM',
  '1pm':    '1:00 PM',
  '2pm':    '2:00 PM',
  '4pm':    '4:00 PM',
};
const ASSIST_TIME_ORDER = { '7am': 0, '9:30am': 1, '1pm': 2, '2pm': 3, '4pm': 4 };
// Days before the appointment that a request becomes visible to others (at 8 AM that day).
const ASSIST_VISIBILITY_DAYS = { Endo: 7, Fixed: 1, Remo: 1, Operative: 1 };

/* CDT code fee reference. Fee = Maryland Healthy Smiles pays + patient pays.
 * Frequency limits and pre-auth flags below are pulled from the Maryland
 * Healthy Smiles Provider Manual V16 (effective 1/1/2025). Where adult and
 * child limits differ, the adult limit is shown first and the child/REM
 * variant appears in parentheses. "Kids only" = covered for Children < 21,
 * REM Children, and Former Foster Care (21–25) but not the Adult plans.
 *
 * Cost-sharing model: Maryland Medicaid does not charge participants for
 * covered services within frequency limits — so for every MHS-covered code
 * MHS pays the full fee and the patient pays $0. Patient-pays is only > 0
 * for codes MHS does not cover (e.g. implants, fixed bridges, cast-metal
 * partials) or when the service exceeds frequency limits. Fees come from
 * the separate 2025 Dental Fee Schedule; $0 entries are either not in the
 * fee schedule or school-specific codes.
 *
 * These numbers are a quick reference only — ALWAYS verify the current fee,
 * coverage, and frequency with MHS / the Provider Manual before quoting a
 * patient or submitting a claim. */
const PROCEDURE_COSTS = [
  // [code, description, fee, mhsPays, patientPays, frequency, preAuth]

  /* Diagnostic (D0xxx) */
  ['D0120',   'Periodic oral evaluation',                    46, 46,  0, '2× / 12 mo; 120-day lockout w/ D0145/D0150/D0160', 'No'],
  ['D0140',   'Limited oral eval - problem focused',         53, 53,  0, 'Pain eval only; not w/ routine services',          'No'],
  ['D0145',   'Oral eval, patient under 3 + caregiver',       0,     0,    0, 'Kids <3: 2× / 12 mo',                              'No'],
  ['D0150',   'Comprehensive oral evaluation',               67, 67,  0, '1× / 3 years per provider/location',               'No'],
  ['D0160',   'Detailed/extensive eval - problem focused',    0,     0,    0, '1× / 3 years per provider/location',               'No'],
  ['D0210',   'Intraoral complete series (FMS)',            170, 170,  0, '1× / 36 mo (shares limit w/ D0330)',               'No'],
  ['D0220',   'Periapical - first image',                     0,     0,    0, '1× on same DOS as endo',                           'No'],
  ['D0230',   'Periapical - each additional image',           0,     0,    0, 'No limit',                                         'No'],
  ['D0240',   'Occlusal radiographic image',                  0,     0,    0, 'Kids: 2× / 12 mo',                                 'No'],
  ['D0250',   'Extraoral - first image',                      0,     0,    0, 'Kids: no limit',                                   'No'],
  ['D0270',   'Bitewing - single image',                      0,     0,    0, 'Adult: 1× / 12 mo (Kids / REM: 1× / 6 mo)',        'No'],
  ['D0272',   'Bitewings - two images',                       0,     0,    0, 'Adult: 1× / 12 mo (Kids / REM: 1× / 6 mo)',        'No'],
  ['D0273',   'Bitewings - three images',                     0,     0,    0, 'Adult: 1× / 12 mo (Kids 10+ / REM: 1× / 6 mo)',    'No'],
  ['D0274',   'Bitewings - four images',                      0,     0,    0, 'Adult: 1× / 12 mo (Kids 10+ / REM: 1× / 6 mo)',    'No'],
  ['D0330',   'Panoramic radiograph',                       111, 111,  0, '1× / 36 mo (shares limit w/ D0210)',               'No'],
  ['D0310',   'Sialography',                                  0,     0,    0, 'Kids: no specific limit',                          'No'],
  ['D0320',   'TMJ arthrogram, incl. injection',              0,     0,    0, 'Kids: no specific limit',                          'No'],
  ['D0321',   'Other TMJ films, by report',                   0,     0,    0, 'Kids: no specific limit',                          'No'],
  ['D0340',   '2D cephalometric image',                       0,     0,    0, 'Kids: 1× / 36 mo, non-ortho only',                 'No'],
  ['D0431',   'Adjunctive oral cancer screen',                0,     0,    0, 'Kids 0-20: 1× / 12 mo',                            'No'],
  ['D0460',   'Pulp vitality test',                           0,     0,    0, 'Kids: 1× / visit',                                 'No'],

  /* Preventive (D1xxx) */
  ['D1110',   'Prophylaxis (adult)',                         86, 86,  0, '2× / 12 mo, min 120 days (REM: 1× / 3 mo)',        'No'],
  ['D1120',   'Prophylaxis (child)',                          0,     0,    0, 'Kids 0-13: 2× / 12 mo (REM: 1× / 3 mo)',           'No'],
  ['D1206',   'Topical fluoride varnish',                    33, 33,  0, '1× / 6 mo (Kids 0-5: 4×/yr per prov, 8× max; 6-25: 4×/yr)', 'No'],
  ['D1208',   'Topical fluoride - excluding varnish',        33, 33,  0, '1× / 6 mo (REM: 1× / 3 mo)',                       'No'],
  ['D1330',   'Oral hygiene instructions',                    0,     0,    0, 'Kids: 1× / 12 mo',                                 'No'],
  ['D1351',   'Sealant - per tooth',                          0,     0,    0, 'Kids: 1× lifetime per tooth (perm posterior only)', 'No'],
  ['D1352',   'Preventive resin restoration',                 0,     0,    0, 'Kids: 1× lifetime per tooth',                      'No'],
  ['D1354',   'Silver diamine fluoride (SDF)',                0,     0,    0, 'Kids: 1× / 6 mo per tooth, max 4 lifetime (ages 7+ need preauth)', 'Yes'],
  ['D1510',   'Fixed unilateral space maintainer',            0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'No'],
  ['D1516',   'Fixed bilateral space maintainer - maxillary', 0,     0,    0, 'Kids: 1× / 24 mo (D1516 or D1526)',                'No'],
  ['D1517',   'Fixed bilateral space maintainer - mand.',     0,     0,    0, 'Kids: 1× / 24 mo (D1517 or D1527)',                'No'],
  ['D1520',   'Removable unilateral space maintainer',        0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'No'],
  ['D1526',   'Removable bilateral space maintainer - max',   0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D1516)',               'No'],
  ['D1527',   'Removable bilateral space maintainer - mand.', 0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D1517)',               'No'],
  ['D1553',   'Re-cement or re-bond unilateral space maint.', 0,     0,    0, 'Kids: not w/in 6 mo of initial placement',         'No'],
  ['D1556',   'Removal of fixed unilateral space maint.',     0,     0,    0, 'Kids: not by placing office',                      'No'],

  /* Restorative (D2xxx) */
  ['D2140',   'Amalgam - 1 surface',                          0,     0,    0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2150',   'Amalgam - 2 surfaces',                         0,     0,    0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2160',   'Amalgam - 3 surfaces',                         0,     0,    0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2161',   'Amalgam - 4+ surfaces',                        0,     0,    0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2330',   'Resin composite 1-surf anterior',            110, 110,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2331',   'Resin composite 2-surf anterior',            138, 138,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2332',   'Resin composite 3-surf anterior',            169, 169,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2335',   'Resin composite 4+ surf anterior',           213, 213,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2390',   'Resin composite crown, anterior',              0,     0,    0, 'Kids: not w/ endo (D3310-D3348) same DOS',         'No'],
  ['D2391',   'Resin composite 1-surf posterior',           129, 129,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2392',   'Resin composite 2-surf posterior',           155, 155,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2393',   'Resin composite 3-surf posterior',           197, 197,  0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2394',   'Resin composite 4+ surf posterior',          241, 241,   0, '1× / surface / 24 mo; 1× / tooth / 6 mo',          'No'],
  ['D2721',   'Crown resin w/ predominantly base metal',      0,     0,    0, 'Kids: 1× / 60 mo per tooth',                       'Yes'],
  ['D2740',   'Crown porcelain/ceramic',                    713, 713,   0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2750',   'Crown PFM high noble metal',                   0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2751',   'Crown PFM predominantly base metal',          713, 713,   0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2752',   'Crown PFM noble metal',                        0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2780',   'Crown ¾ cast high noble metal',                0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2781',   'Crown ¾ cast predominantly base metal',        0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2782',   'Crown ¾ cast noble metal',                     0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2783',   'Crown ¾ porcelain/ceramic',                    0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2790',   'Crown full cast high noble metal',             0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2791',   'Crown full cast predominantly base metal',     0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2792',   'Crown full cast noble metal',                  0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2794',   'Crown titanium',                               0,     0,    0, '1× / 60 mo per tooth',                             'Yes'],
  ['D2799',   'Provisional crown',                          266, 0, 266, 'Bridge to definitive',                             'No'],
  ['D2910',   'Re-cement or re-bond inlay/onlay/veneer',      0,     0,    0, 'No limit',                                         'No'],
  ['D2920',   'Re-cement or re-bond crown',                   0,     0,    0, 'Adult: 2× / lifetime per tooth, not w/in 6 mo of placement', 'No'],
  ['D2928',   'Prefab porcelain/ceramic crown - permanent',   0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'No'],
  ['D2929',   'Prefab porcelain/ceramic crown - primary',     0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'Yes'],
  ['D2930',   'Prefab stainless-steel crown - primary',       0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'No'],
  ['D2931',   'Prefab stainless-steel crown - permanent',     0,     0,    0, '1× / 60 mo per tooth',                             'No'],
  ['D2932',   'Prefab resin crown',                           0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'No'],
  ['D2933',   'Prefab SS crown w/ resin window',              0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'No'],
  ['D2934',   'Prefab esthetic coated SS crown - primary',    0,     0,    0, 'Kids: 1× / 36 mo per tooth',                       'No'],
  ['D2940',   'Protective restoration',                      82, 82,  0, '1× / tooth / lifetime',                            'No'],
  ['D2941',   'Interim therapeutic restoration (ITR)',        0,     0,    0, 'Kids: primary teeth, caries control',              'No'],
  ['D2950',   'Core buildup incl pins',                     199, 199,  0, '1× / 60 mo per tooth (shares w/ D2952/D2954)',     'Yes'],
  ['D2951',   'Pin retention - per tooth',                    0,     0,    0, 'No limit',                                         'No'],
  ['D2952',   'Cast post and core in addition to crown',      0,     0,    0, '1× / 60 mo per tooth (shares w/ D2950/D2954)',     'Yes'],
  ['D2954',   'Prefab post and core',                       243, 243,   0, '1× / 60 mo per tooth (shares w/ D2950/D2952)',     'Yes'],
  ['D2955',   'Post removal',                                 0,     0,    0, 'Kids: not w/ D3346-D3348 same DOS',                'Yes'],
  ['D2960',   'Labial veneer, chairside',                     0,     0,    0, 'Kids 6-11: 1× / 60 mo per tooth',                  'Yes'],
  ['D2961',   'Labial veneer (resin) - lab',                  0,     0,    0, 'Kids 6-11: 1× / 60 mo per tooth',                  'Yes'],
  ['D2962',   'Labial veneer (porcelain) - lab',              0,     0,    0, 'Kids 6-11: 1× / 60 mo per tooth',                  'Yes'],
  ['D2980',   'Crown repair, by report',                      0,     0,    0, 'No limit',                                         'No'],
  ['D2999.1', 'Unspecified restorative',                     89, 0, 89, 'Reporting code',                                   'Yes'],

  /* Endodontics (D3xxx) */
  ['D3110',   'Pulp cap - direct',                            0,     0,    0, 'No limit',                                         'No'],
  ['D3120',   'Pulp cap - indirect',                          0,     0,    0, 'No limit',                                         'No'],
  ['D3220',   'Therapeutic pulpotomy',                        0,     0,    0, 'No limit',                                         'No'],
  ['D3221',   'Pulpal debridement',                           0,     0,    0, 'No limit',                                         'No'],
  ['D3230',   'Pulpal therapy - anterior primary',            0,     0,    0, 'Kids: 1× lifetime per tooth',                      'No'],
  ['D3240',   'Pulpal therapy - posterior primary',           0,     0,    0, 'Kids: 1× lifetime per tooth',                      'No'],
  ['D3310',   'Endodontic therapy anterior',                499, 499,   0, '1× lifetime per tooth',                            'Yes'],
  ['D3320',   'Endodontic therapy premolar',                584, 584,   0, '1× lifetime per tooth',                            'Yes'],
  ['D3330',   'Endodontic therapy molar',                   713, 713,   0, '1× lifetime per tooth',                            'Yes'],
  ['D3346',   'Retreatment root canal - anterior',            0,     0,    0, '1× lifetime per tooth, not w/in 24 mo of initial', 'Yes'],
  ['D3347',   'Retreatment root canal - premolar',            0,     0,    0, '1× lifetime per tooth, not w/in 24 mo of initial', 'Yes'],
  ['D3348',   'Retreatment root canal - molar',               0,     0,    0, '1× lifetime per tooth, not w/in 24 mo of initial', 'Yes'],
  ['D3351',   'Apexification - initial visit',                0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3352',   'Apexification - interim',                      0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3353',   'Apexification - final',                        0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3410',   'Apicoectomy - anterior',                       0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3421',   'Apicoectomy - premolar (first root)',          0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3425',   'Apicoectomy - molar (first root)',             0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3426',   'Apicoectomy - each additional root',           0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3430',   'Retrograde filling - per root',                0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3450',   'Root amputation - per root',                   0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3470',   'Intentional reimplantation',                   0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D3920',   'Hemisection (incl. root removal)',             0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],

  /* Periodontics (D4xxx) */
  ['D4210',   'Gingivectomy/plasty - 4+ teeth / quad',        0,     0,    0, '1× / 24 mo per quadrant; max 2 quads / 12 mo',     'Yes'],
  ['D4211',   'Gingivectomy/plasty - 1-3 teeth / quad',       0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'Yes'],
  ['D4230',   'Anatomical crown exposure - 4+ teeth',         0,     0,    0, 'Kids: 1× lifetime',                                'Yes'],
  ['D4231',   'Anatomical crown exposure - 1-3 teeth',        0,     0,    0, 'Kids: 1× lifetime',                                'Yes'],
  ['D4240',   'Gingival flap w/ root planing - 4+ teeth',     0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'Yes'],
  ['D4241',   'Gingival flap w/ root planing - 1-3 teeth',    0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'Yes'],
  ['D4249',   'Clinical crown lengthening - hard tissue',   542, 542,   0, 'Kids: 1× / 24 mo per tooth (Adult: not covered by MHS)', 'Yes'],
  ['D4260',   'Osseous surgery - 4+ teeth / quad',            0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'Yes'],
  ['D4261',   'Osseous surgery - 1-3 teeth / quad',           0,     0,    0, 'Kids: 1× / 24 mo per quadrant',                    'Yes'],
  ['D4322',   'Splint intra-coronal - natural/crown',         0,     0,    0, 'Kids: narrative + X-rays required',                'No'],
  ['D4323',   'Splint extra-coronal - natural/crown',         0,     0,    0, 'Kids: narrative + X-rays required',                'No'],
  ['D4341',   'Scaling/root planing 4+ teeth per quad',     115, 115,  0, 'Adult: 1× / 12 mo per quad (kids: 1× / 24 mo)',    'Yes'],
  ['D4342',   'Scaling/root planing 1-3 teeth per quad',     92, 92,  0, 'Adult: 1× / 12 mo per quad (kids: 1× / 24 mo)',    'Yes'],
  ['D4355',   'Full mouth debridement',                        0,     0,    0, '1× / 24 mo (REM: 1× / 12 mo); not w/ D1110 same DOS', 'No'],
  ['D4910',   'Periodontal maintenance',                    113, 113,  0, '2× / 12 mo; not w/in 90 days of SRP',              'Yes'],
  ['D4920',   'Unscheduled dressing change',                   0,     0,    0, 'Kids: not by original treating dentist',           'Yes'],

  /* Prosthodontics - removable (D5xxx) */
  ['D5110',   'Complete denture - maxillary',              1085, 1085,   0, 'Kids/FFC: 1× / 60 mo',                             'Yes'],
  ['D5120',   'Complete denture - mandibular',             1085, 1085,   0, 'Kids/FFC: 1× / 60 mo',                             'Yes'],
  ['D5211',   'Partial denture - max resin base',             0,     0,    0, 'Kids/FFC: 1× / 60 mo (shares w/ D5225)',           'Yes'],
  ['D5212',   'Partial denture - mand resin base',            0,     0,    0, 'Kids/FFC: 1× / 60 mo (shares w/ D5226)',           'Yes'],
  ['D5213',   'Partial denture - max cast metal frame',    1172,   0, 1172, 'Not a MHS covered service',                        'Yes'],
  ['D5214',   'Partial denture - mand cast metal frame',   1172,   0, 1172, 'Not a MHS covered service',                        'Yes'],
  ['D5225',   'Partial denture - max flexible base',          0,     0,    0, 'Kids/FFC: 1× / 60 mo (shares w/ D5211)',           'Yes'],
  ['D5226',   'Partial denture - mand flexible base',         0,     0,    0, 'Kids/FFC: 1× / 60 mo (shares w/ D5212)',           'Yes'],
  ['D5410',   'Adjust complete denture - maxillary',          0,     0,    0, 'Not w/in 6 mo of placement',                       'No'],
  ['D5411',   'Adjust complete denture - mandibular',         0,     0,    0, 'Not w/in 6 mo of placement',                       'No'],
  ['D5421',   'Adjust partial denture - maxillary',           0,     0,    0, 'Not w/in 6 mo of placement',                       'No'],
  ['D5422',   'Adjust partial denture - mandibular',          0,     0,    0, 'Not w/in 6 mo of placement',                       'No'],
  ['D5511',   'Repair broken complete denture - mand',        0,     0,    0, 'No limit',                                         'No'],
  ['D5512',   'Repair broken complete denture - max',         0,     0,    0, 'No limit',                                         'No'],
  ['D5520',   'Replace missing/broken teeth - complete dent.', 0,    0,    0, 'No limit',                                         'No'],
  ['D5611',   'Repair resin partial denture base - mand',      0,    0,    0, 'Kids: no limit',                                   'No'],
  ['D5612',   'Repair resin partial denture base - max',       0,    0,    0, 'Kids: no limit',                                   'No'],
  ['D5621',   'Repair cast partial framework - mand',          0,    0,    0, 'Kids: no limit',                                   'No'],
  ['D5622',   'Repair cast partial framework - max',           0,    0,    0, 'Kids: no limit',                                   'No'],
  ['D5630',   'Repair or replace broken clasp',                0,    0,    0, 'No limit',                                         'No'],
  ['D5640',   'Replace missing/broken teeth - partial dent.',  0,    0,    0, 'No limit',                                         'No'],
  ['D5650',   'Add tooth to existing partial - per tooth',    0,     0,    0, 'Kids: no limit',                                   'No'],
  ['D5660',   'Add clasp to existing partial',                0,     0,    0, 'Kids: no limit',                                   'No'],
  ['D5710',   'Rebase complete maxillary denture',            0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5750); not w/in 6 mo', 'Yes'],
  ['D5711',   'Rebase complete mandibular denture',           0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5751); not w/in 6 mo', 'Yes'],
  ['D5720',   'Rebase maxillary partial denture',             0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5760); not w/in 6 mo', 'Yes'],
  ['D5721',   'Rebase mandibular partial denture',            0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5761); not w/in 6 mo', 'Yes'],
  ['D5750',   'Reline complete max denture (lab)',            0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5710); not w/in 6 mo', 'No'],
  ['D5751',   'Reline complete mand denture (lab)',           0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5711); not w/in 6 mo', 'No'],
  ['D5760',   'Reline maxillary partial denture (lab)',       0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5720); not w/in 6 mo', 'No'],
  ['D5761',   'Reline mandibular partial denture (lab)',      0,     0,    0, 'Kids: 1× / 24 mo (shares w/ D5721); not w/in 6 mo', 'No'],
  ['D5820',   'Interim partial denture - maxillary',        463,   0, 463, 'Not a MHS covered service',                        'Yes'],
  ['D5821',   'Interim partial denture - mandibular',       463,   0, 463, 'Not a MHS covered service',                        'Yes'],
  ['D5850',   'Tissue conditioning - maxillary',              0,     0,    0, 'Kids: prior to new denture impression only',       'No'],
  ['D5851',   'Tissue conditioning - mandibular',             0,     0,    0, 'Kids: prior to new denture impression only',       'No'],
  ['D5863',   'Overdenture - complete maxillary',             0,     0,    0, 'Kids: 1× / 60 mo',                                 'Yes'],
  ['D5864',   'Overdenture - partial maxillary',              0,     0,    0, 'Kids: 1× / 60 mo',                                 'Yes'],
  ['D5865',   'Overdenture - complete mandibular',            0,     0,    0, 'Kids: 1× / 60 mo',                                 'Yes'],
  ['D5866',   'Overdenture - partial mandibular',             0,     0,    0, 'Kids: 1× / 60 mo',                                 'Yes'],
  ['D5992',   'Adjust maxillofacial prosthetic appliance',    0,     0,    0, 'Kids: 1× / 6 mo per arch',                         'Yes'],
  ['D5993',   'Maintenance/cleaning of maxillofacial pros.',  0,     0,    0, 'Kids: 1× / 6 mo per arch',                         'Yes'],

  /* Prosthodontics - fixed & implants (D6xxx) - not covered for adults under MHS */
  ['D6010',   'Implant surgical placement',                1395, 0, 1395, 'Not a MHS covered service',                        'Yes'],
  ['D6057',   'Custom abutment',                            521, 0, 521, 'Not a MHS covered service',                        'Yes'],
  ['D6058',   'Abutment-supported porcelain/ceramic crown', 812, 0, 812, 'Not a MHS covered service',                        'Yes'],
  ['D6065',   'Implant porcelain/ceramic crown',            874, 0, 874, 'Not a MHS covered service',                        'Yes'],
  ['D6190',   'Radiographic/surgical implant index',        233, 0, 233, 'Not a MHS covered service',                        'Yes'],
  ['D6241',   'Pontic PFM predominantly base metal',        696,   0, 696, 'Not a MHS covered service',                        'Yes'],
  ['D6245',   'Pontic porcelain/ceramic',                   696,   0, 696, 'Not a MHS covered service',                        'Yes'],
  ['D6740',   'Retainer crown porcelain/ceramic',           696,   0, 696, 'Not a MHS covered service',                        'Yes'],
  ['D6751',   'Retainer crown PFM base metal',              696,   0, 696, 'Not a MHS covered service',                        'Yes'],
  ['D6930',   'Re-cement or re-bond fixed partial denture',   0,     0,    0, 'Adult: 2× lifetime per bridge',                    'No'],

  /* Oral & Maxillofacial Surgery (D7xxx) */
  ['D7111',   'Extraction, coronal remnants - deciduous',     0,     0,    0, 'No limit',                                         'No'],
  ['D7140',   'Extraction erupted tooth',                   108, 108, 0, 'No limit',                                         'No'],
  ['D7210',   'Surgical removal of erupted tooth',            0,     0,    0, 'No limit',                                         'No'],
  ['D7220',   'Removal of impacted tooth - soft tissue',      0,     0,    0, 'Asymptomatic not covered',                         'No'],
  ['D7230',   'Removal of impacted tooth - partially bony',   0,     0,    0, 'Asymptomatic not covered',                         'No'],
  ['D7240',   'Removal of impacted tooth - completely bony',  0,     0,    0, 'Asymptomatic not covered',                         'No'],
  ['D7241',   'Impacted completely bony + surgical complic.', 0,     0,    0, 'Kids: asymptomatic not covered',                   'Yes'],
  ['D7250',   'Surgical removal of residual tooth roots',     0,     0,    0, 'Not paid to dentist who removed tooth',            'Yes'],
  ['D7251',   'Coronectomy - intentional partial removal',    0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D7260',   'Oroantral fistula closure',                    0,     0,    0, 'Kids: narrative required',                         'Yes'],
  ['D7270',   'Reimplantation/stabilization of evulsed tooth', 0,    0,    0, 'Kids: incl splinting/stabilization',               'Yes'],
  ['D7272',   'Tooth transplantation (reimplant site→site)',  0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D7280',   'Surgical access of unerupted tooth',           0,     0,    0, 'Kids: only w/ authorized ortho',                   'Yes'],
  ['D7284',   'Excisional biopsy of minor salivary glands',   0,     0,    0, 'Not w/ D7286 same DOS; pathology report req.',     'No'],
  ['D7285',   'Incisional biopsy oral tissue - hard',         0,     0,    0, 'Pathology report required',                        'No'],
  ['D7286',   'Incisional biopsy oral tissue - soft',         0,     0,    0, 'Pathology report required',                        'No'],
  ['D7290',   'Surgical repositioning of teeth',              0,     0,    0, 'Kids: 1× lifetime per tooth',                      'Yes'],
  ['D7310',   'Alveoloplasty w/ extractions - 4+ teeth',      0,     0,    0, '1× lifetime per quadrant; min 3 extractions',      'No'],
  ['D7311',   'Alveoloplasty w/ extractions - 1-3 teeth',     0,     0,    0, 'Kids: 1× lifetime per quadrant',                   'Yes'],
  ['D7320',   'Alveoloplasty w/o extractions - 4+ teeth',     0,     0,    0, '1× lifetime per quadrant',                         'Yes'],
  ['D7321',   'Alveoloplasty w/o extractions - 1-3 teeth',    0,     0,    0, 'Kids: 1× lifetime per quadrant',                   'Yes'],
  ['D7340',   'Vestibuloplasty - ridge extension (2° epith.)', 0,    0,    0, 'Kids: narrative + X-rays required',                'Yes'],
  ['D7350',   'Vestibuloplasty - ridge extension',            0,     0,    0, 'Kids: narrative + X-rays required',                'Yes'],
  ['D7410',   'Radical excision - lesion ≤1.25cm',            0,     0,    0, 'Kids: pathology report required',                  'No'],
  ['D7440',   'Excision of malignant tumor - ≤1.25cm',        0,     0,    0, 'Kids: pathology report required',                  'No'],
  ['D7450',   'Removal odontogenic cyst/tumor - ≤1.25cm',     0,     0,    0, 'Kids only; pathology report required',             'No'],
  ['D7451',   'Removal odontogenic cyst/tumor - >1.25cm',     0,     0,    0, 'Kids only; pathology report required',             'No'],
  ['D7460',   'Removal non-odontogenic cyst/tumor - ≤1.25cm', 0,     0,    0, 'Kids only; pathology report required',             'No'],
  ['D7461',   'Removal non-odontogenic cyst/tumor - >1.25cm', 0,     0,    0, 'Kids only; pathology report required',             'No'],
  ['D7471',   'Removal of exostosis - per site',              0,     0,    0, 'Kids only',                                        'Yes'],
  ['D7472',   'Removal of torus palatinus',                   0,     0,    0, 'Kids only',                                        'Yes'],
  ['D7473',   'Removal of torus mandibularis',                0,     0,    0, 'Kids only',                                        'Yes'],
  ['D7510',   'I&D of abscess - intraoral soft tissue',       0,     0,    0, 'Adult: not w/ extraction',                         'No'],
  ['D7520',   'I&D of abscess - extraoral soft tissue',       0,     0,    0, 'No limit',                                         'No'],
  ['D7550',   'Partial ostectomy/sequestrectomy',             0,     0,    0, 'Kids: per quadrant',                               'No'],
  ['D7961',   'Buccal/labial frenectomy',                     0,     0,    0, 'Kids: 1× lifetime',                                'Yes'],
  ['D7962',   'Lingual frenectomy',                           0,     0,    0, 'Kids: 1× lifetime',                                'Yes'],
  ['D7970',   'Excision of hyperplastic tissue - per arch',   0,     0,    0, 'Kids: over edentulous denture area only',          'No'],
  ['D7971',   'Excision of pericoronal gingiva',              0,     0,    0, 'Kids: 1× lifetime per tooth',                      'No'],

  /* Orthodontics (D8xxx) - Kids only, HLD ≥15 */
  ['D8080',   'Comprehensive ortho - adolescent',             0,     0,    0, 'Kids: 1× lifetime (HLD ≥15)',                      'Yes'],
  ['D8090',   'Comprehensive ortho - self-ligating',          0,     0,    0, 'Kids: 1× lifetime (self-lig cases only)',          'Yes'],
  ['D8660',   'Pre-ortho treatment exam',                     0,     0,    0, 'Kids: 1× / 12 mo; only w/ D8080 request',          'No'],
  ['D8670',   'Periodic ortho treatment visit',               0,     0,    0, 'Kids: max 24 lifetime (12 for self-lig)',          'Yes'],
  ['D8680',   'Orthodontic retention (appliance removal)',    0,     0,    0, 'Kids: 1× lifetime',                                'Yes'],
  ['D8698',   'Re-cement fixed retainer - maxillary',         0,     0,    0, 'Kids: 1× w/in 24 mo of debanding',                 'Yes'],
  ['D8699',   'Re-cement fixed retainer - mandibular',        0,     0,    0, 'Kids: 1× w/in 24 mo of debanding',                 'Yes'],
  ['D8703',   'Replace lost/broken retainer - maxillary',     0,     0,    0, 'Kids: 1× lifetime w/in 24 mo of debanding',        'Yes'],
  ['D8704',   'Replace lost/broken retainer - mandibular',    0,     0,    0, 'Kids: 1× lifetime w/in 24 mo of debanding',        'Yes'],
  ['D8999',   'Orthodontic continuation of care',             0,     0,    0, 'Kids: 1× lifetime, different payee only',          'Yes'],

  /* Adjunctive (D9xxx) */
  ['D9110',   'Palliative treatment of dental pain',          0,     0,    0, 'Only w/ radiographs; not w/ other services',       'No'],
  ['D9222',   'Deep sedation / GA - first 15 min',            0,     0,    0, '1 per day',                                        'No'],
  ['D9223',   'Deep sedation / GA - each 15 min',             0,     0,    0, 'Max 90 min (6 units); not w/ D9230/D9243/D9248',   'No'],
  ['D9230',   'Nitrous oxide / anxiolysis',                   0,     0,    0, 'Not w/ D9223/D9243/D9248',                         'No'],
  ['D9239',   'IV moderate sedation - first 15 min',          0,     0,    0, '1 per day',                                        'No'],
  ['D9243',   'IV moderate sedation - each 15 min',           0,     0,    0, 'Max 90 min (6 units); not w/ D9223/D9230/D9248',   'No'],
  ['D9248',   'Non-IV moderate (conscious) sedation',         0,     0,    0, 'Not w/ D9223/D9230/D9243',                         'No'],
  ['D9310',   'Consultation - diagnostic service',            0,     0,    0, 'Not w/in 90 days of D0120/D0140/D0150',            'No'],
  ['D9410',   'House/extended care facility call',            0,     0,    0, 'Kids: report required',                            'Yes'],
  ['D9420',   'Hospital or ambulatory surgical center call',  0,     0,    0, 'Kids: requires ASC/OP approval',                   'No'],
  ['D9910',   'Application of desensitizing medicament',      0,     0,    0, 'Kids: 1× / visit',                                 'No'],
  ['D9941',   'Fabrication of athletic mouthguard',           0,     0,    0, 'Kids: 1× / 12 mo',                                 'No'],
  ['D9944',   'Occlusal guard - hard appliance, full arch',  403, 403,   0, 'Kids: 1× / 24 mo, shares D9944-D9946 (Adult: not covered by MHS)', 'No'],
  ['D9945',   'Occlusal guard - soft appliance, full arch',   0,     0,    0, 'Kids: 1× / 24 mo, shares D9944-D9946 (Adult: not covered by MHS)', 'No'],
  ['D9946',   'Occlusal guard - hard appliance, partial arch', 0,    0,    0, 'Kids: 1× / 24 mo, shares D9944-D9946 (Adult: not covered by MHS)', 'No'],
  ['D9951',   'Occlusal adjustment - limited',                0,     0,    0, '1× / 12 mo; not w/ restorative same DOS',          'No'],
  ['D9952',   'Occlusal adjustment - complete',               0,     0,    0, '1× / 12 mo; not w/ restorative same DOS',          'No'],
  ['D9999',   'Unspecified adjunctive procedure (by report)', 0,     0,    0, 'Facility referral; narrative required',            'Yes'],

  /* School-specific reporting codes (not in MHS manual) */
  ['D9450',   'Case presentation',                            0,     0,    0, 'Reporting code',                                   'No'],
  ['D9450.2', 'Perio case presentation',                      0,     0,    0, 'Reporting code',                                   'No'],
  ['D9450.3', 'Fixed case presentation',                      0,     0,    0, 'Reporting code',                                   'No'],
  ['D9450.6', 'Treatment plan update',                        0,     0,    0, 'Reporting code',                                   'No'],
];

const state = {
  profile: null,        // { name, sNumber, phone }
  pendingSNumber: null, // set while we're showing the "complete profile" form
  blocks: [],
  filterType: '',
  filterTime: '',
  calMonth: null,
  selectedDate: null,
  view: 'calendar',
  firestoreReady: false,
  schedule: [],         // user's imported schedule (local-only, per-device)
  myBlocksMode: 'display', // 'display' | 'edit' — sub-mode of the My Blocks view
  isAdmin: false,
  sessionId: null,      // id of the Firestore session doc for this tab
  heartbeatTimer: null,
  assists: [],          // assist requests visible to the current view (subscribed only on Assist tab)
  assistTab: 'board',   // 'board' | 'mine' | 'post'
  assistFilterProcedure: '',
  assistTickTimer: null,
  admin: {
    loaded: false,
    users: [],          // [{sNumber, name, phone, createdAt, updatedAt, ...}]
    sessions: [],       // recent sessions (last ~30 days)
    allBlocks: [],      // every block, any date
    selectedUser: null, // sNumber of expanded row
    subView: 'users',   // 'users' | 'calendar'
    calMonth: null,
    selectedDate: null,
    filterType: '',
    filterTime: '',
    filterUser: '',
  },
};

/* Admin gate: the expected hash lives in Firestore at config/admin.hash
 * (PBKDF2-SHA-256, 200k iterations, fixed salt). Reads are gated by
 * anonymous auth, so the hash isn't exposed to anyone loading the JS
 * bundle. Users bootstrap by visiting ?adminkey=<secret>; the client
 * signs in anon, fetches the hash, compares, and stores a localStorage
 * flag if it matches — admin stays unlocked on that browser only. */
const ADMIN_KDF_SALT = 'umsod-admin-v1';
const ADMIN_KDF_ITERATIONS = 200000;
const ADMIN_FLAG_KEY = 'umsod-admin-enabled-v1';
const ADMIN_SNUMBER = 'S42585'; // Admin tab is only exposed to this S# while the localStorage flag is also set.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ONLINE_WINDOW_MS = 6 * 60 * 1000;      // mark "online" if heartbeat within 6 min

let db = null;
let blocksUnsub = null;
let assistsUnsub = null;

/* Simple per-session rate limiter. Prevents accidental rapid-fire and
 * makes casual abuse annoying. Server-side protection is Firestore rules
 * + App Check (see README). */
const rateLimits = {
  signIn: { max: 8, windowMs: 60 * 1000, times: [] },
  post:   { max: 6, windowMs: 60 * 1000, times: [] },
};
function rateLimitOk(key) {
  const cfg = rateLimits[key];
  const now = Date.now();
  cfg.times = cfg.times.filter((t) => now - t < cfg.windowMs);
  if (cfg.times.length >= cfg.max) return false;
  cfg.times.push(now);
  return true;
}

/* ----------------------------- utilities ----------------------------- */

function $(id) { return document.getElementById(id); }

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseYmd(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function prettyDate(str) {
  const d = parseYmd(str);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function telHref(raw) { return `tel:${(raw || '').replace(/\D/g, '')}`; }
function smsHref(raw) { return `sms:${(raw || '').replace(/\D/g, '')}`; }

function isWeekday(dateStr) {
  const d = parseYmd(dateStr).getDay();
  return d >= 1 && d <= 5;
}

function validSNumber(s) { return /^S\d{5}$/.test(s); }
function phoneDigits(p) { return (p || '').replace(/\D/g, ''); }
function hasPhone(p) { return phoneDigits(p).length >= 10; }
function validPhoneOrEmpty(p) {
  const d = phoneDigits(p);
  return d.length === 0 || d.length >= 10;
}
function validName(n) { return typeof n === 'string' && n.trim().length > 0; }
function validPin(p) { return /^\d{4,6}$/.test(p || ''); }
function profileValid(p) {
  return p && validName(p.name) && validSNumber(p.sNumber) && validPhoneOrEmpty(p.phone);
}

/* ----------------------------- PIN hashing ----------------------------- */

/* PBKDF2 via Web Crypto. Salted with the S# so identical PINs for different
 * users produce different hashes. 200k iterations ≈ 150-400ms on modern
 * devices — fast enough for login, slow enough to make casual brute force
 * of a 4-6 digit PIN annoying if the users collection is ever scraped. */
async function hashPin(sNumber, pin) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto not available in this browser.');
  }
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('umsod-be:' + sNumber), iterations: 200000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ----------------------------- local cache ----------------------------- */

function loadLocalProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) state.profile = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

function cacheProfile(p) {
  state.profile = p;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

function clearLocalProfile() {
  state.profile = null;
  localStorage.removeItem(PROFILE_KEY);
}

/* ----------------------------- firestore ----------------------------- */

function initFirestore() {
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    console.warn('Firebase not configured — data will not sync between users.');
    return false;
  }
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg.apiKey || cfg.apiKey.startsWith('REPLACE_')) {
    console.warn('Firebase config has placeholder values. Fill in firebase-config.js.');
    showSetupWarning();
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);

    // Optional: Firebase App Check with reCAPTCHA v3. When enabled it
    // blocks writes that don't come from the real site (the #1 spam
    // defense). Activated only if the site key is set in
    // firebase-config.js and the App Check compat SDK loaded.
    if (window.RECAPTCHA_V3_SITE_KEY && firebase.appCheck) {
      try {
        self.FIREBASE_APPCHECK_DEBUG_TOKEN =
          self.FIREBASE_APPCHECK_DEBUG_TOKEN || false;
        firebase.appCheck().activate(window.RECAPTCHA_V3_SITE_KEY, true);
      } catch (e) {
        console.warn('App Check activation failed:', e);
      }
    }

    db = firebase.firestore();
    state.firestoreReady = true;
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

function subscribeBlocks() {
  if (!state.firestoreReady) return;
  if (blocksUnsub) blocksUnsub();

  // Only listen to blocks whose date is today or later (minus a 1-day grace
  // window so "today morning" shows after midnight passes). This caps the
  // number of reads each client makes and keeps the Firestore free tier safe
  // as old blocks accumulate.
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 1);
  const startStr = ymd(windowStart);

  blocksUnsub = db.collection('blocks')
    .where('date', '>=', startStr)
    .onSnapshot(
      (snap) => {
        state.blocks = [];
        snap.forEach((doc) => {
          state.blocks.push({ id: doc.id, ...doc.data() });
        });
        state.blocks.sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return (a.time || '').localeCompare(b.time || '');
        });
        renderCurrentView();
      },
      (err) => {
        console.error('Firestore subscription error:', err);
        logClientError('blocks-subscribe', err);
        toast('Could not load blocks. Check Firestore rules.');
      }
    );
}

async function fetchUserDoc(sNumber) {
  if (!state.firestoreReady) return null;
  const snap = await db.collection('users').doc(sNumber).get();
  return snap.exists ? snap.data() : null;
}

async function createUserDoc(user) {
  const now = Date.now();
  await db.collection('users').doc(user.sNumber).set({
    sNumber: user.sNumber,
    name: user.name,
    phone: user.phone,
    pinHash: user.pinHash,
    createdAt: now,
    updatedAt: now,
  });
}

async function updateUserDoc(profile) {
  await db.collection('users').doc(profile.sNumber).update({
    name: profile.name,
    phone: profile.phone,
    updatedAt: Date.now(),
  });
}

async function propagateProfileToBlocks(profile) {
  // Update name + phone on blocks the user has already posted, so contact
  // info stays current. Date/time/type/sNumber stay the same.
  if (!state.firestoreReady) return;
  const mine = state.blocks.filter((b) => b.sNumber === profile.sNumber);
  if (mine.length === 0) return;
  const batch = db.batch();
  for (const b of mine) {
    batch.update(db.collection('blocks').doc(b.id), {
      name: profile.name,
      phone: profile.phone,
    });
  }
  await batch.commit();
}

async function postBlockDoc(block) {
  if (!state.firestoreReady) { toast('Data storage is not configured yet.'); return false; }
  await db.collection('blocks').add(block);
  return true;
}

async function deleteBlockDoc(id) {
  if (!state.firestoreReady) return false;
  await db.collection('blocks').doc(id).delete();
  return true;
}

async function setBlockUrgent(id, urgent) {
  if (!state.firestoreReady) return false;
  await db.collection('blocks').doc(id).update({ urgent });
  return true;
}

/* ----------------------------- assists ----------------------------- */

/* Live subscription to upcoming assist requests. Subscribed only while the
 * Assist tab is open so we don't burn reads when nobody is looking. The
 * server-side filter caps the working set to today + future; client-side
 * visibility rules (Endo: 7 days ahead, others: next-day) are applied on
 * top of that, so the rules don't need to know about visibility. */
function subscribeAssists() {
  if (!state.firestoreReady) return;
  if (assistsUnsub) return;
  const todayStr = ymd(new Date());
  assistsUnsub = db.collection('assists')
    .where('date', '>=', todayStr)
    .onSnapshot(
      (snap) => {
        state.assists = [];
        snap.forEach((doc) => state.assists.push({ id: doc.id, ...doc.data() }));
        state.assists.sort(compareAssists);
        if (state.view === 'assist') renderAssistView();
      },
      (err) => {
        console.error('Assists subscription error:', err);
        logClientError('assists-subscribe', err);
        toast('Could not load assist requests.');
      }
    );
}

function unsubscribeAssists() {
  if (assistsUnsub) {
    assistsUnsub();
    assistsUnsub = null;
  }
  state.assists = [];
}

function compareAssists(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const ao = ASSIST_TIME_ORDER[a.time] ?? 99;
  const bo = ASSIST_TIME_ORDER[b.time] ?? 99;
  if (ao !== bo) return ao - bo;
  return (a.procedure || '').localeCompare(b.procedure || '');
}

/* Board ordering inside Today / Upcoming sections: S42585 always pinned to
 * the top of the section, then everyone else by post time (oldest first). */
function compareAssistsForBoard(a, b) {
  const aPinned = a.sNumber === ADMIN_SNUMBER;
  const bPinned = b.sNumber === ADMIN_SNUMBER;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

/* Holographic shimmer controller. Tracks a set of card elements and
 * updates the --holo-* CSS variables that drive the multi-layer foil
 * effect (see styles.css). Inputs:
 *   - scroll position: baseline angle/light source on every device
 *   - deviceorientation: phone tilt refines the light source
 *   - mouse / touch on the card: cursor becomes the light source AND
 *     drives a small 3D tilt, like a real foil card under a lamp
 * The cursor takes over while the pointer is on the card; on leave we
 * fall back to scroll-driven values so motion never freezes. */
const holoCards = new Set();
let holoTilt = null;
let holoRaf = 0;
let holoListenersAttached = false;
function holoUpdate() {
  holoRaf = 0;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  for (const el of holoCards) {
    if (!el.isConnected) { holoCards.delete(el); continue; }
    const rect = el.getBoundingClientRect();
    if (rect.bottom < -100 || rect.top > vh + 100) continue;
    const center = rect.top + rect.height / 2;
    const progress = Math.max(0, Math.min(1, center / vh));

    const cursor = el.__holoCursor;
    let hx, hy, angle, conic, rx = 0, ry = 0;
    if (cursor && cursor.active) {
      hx = cursor.x * 100;
      hy = cursor.y * 100;
      angle = 80 + (cursor.x - 0.5) * 110;
      conic = 90 + cursor.x * 360 + cursor.y * 90;
      ry = (cursor.x - 0.5) * 14;
      rx = -(cursor.y - 0.5) * 12;
    } else {
      angle = 60 + progress * 140;
      hx = 50 + (progress - 0.5) * 80;
      hy = 20 + progress * 60;
      conic = 180 + progress * 220;
    }
    if (holoTilt) {
      angle += holoTilt.x * 25;
      hx += holoTilt.x * 30;
      hy += holoTilt.y * 25;
      ry += holoTilt.x * 6;
      rx -= holoTilt.y * 6;
    }
    el.style.setProperty('--holo-angle', angle + 'deg');
    el.style.setProperty('--holo-x', hx + '%');
    el.style.setProperty('--holo-y', hy + '%');
    el.style.setProperty('--holo-conic', conic + 'deg');
    el.style.setProperty('--holo-rx', ry + 'deg');
    el.style.setProperty('--holo-ry', rx + 'deg');
  }
}
function holoSchedule() {
  if (holoRaf) return;
  holoRaf = requestAnimationFrame(holoUpdate);
}
function holoEnsureListeners() {
  if (holoListenersAttached) return;
  holoListenersAttached = true;
  window.addEventListener('scroll', holoSchedule, { passive: true });
  window.addEventListener('resize', holoSchedule, { passive: true });
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null && e.beta == null) return;
    holoTilt = {
      x: Math.max(-1, Math.min(1, (e.gamma || 0) / 30)),
      y: Math.max(-1, Math.min(1, ((e.beta || 0) - 45) / 45)),
    };
    holoSchedule();
  });
}
function holoSetCursorFromPoint(el, clientX, clientY) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  el.__holoCursor = {
    x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    active: true,
  };
}
function attachHolo(el) {
  if (el.classList.contains('holo')) return;
  el.classList.add('holo');
  if (!el.querySelector(':scope > .holo-foil')) {
    const foil = document.createElement('span');
    foil.className = 'holo-foil';
    foil.setAttribute('aria-hidden', 'true');
    el.insertBefore(foil, el.firstChild);
  }
  el.addEventListener('mouseenter', () => {
    el.classList.add('is-hot');
    holoSchedule();
  });
  el.addEventListener('mousemove', (e) => {
    holoSetCursorFromPoint(el, e.clientX, e.clientY);
    holoSchedule();
  });
  el.addEventListener('mouseleave', () => {
    if (el.__holoCursor) el.__holoCursor.active = false;
    el.classList.remove('is-hot', 'is-pressed');
    holoSchedule();
  });
  el.addEventListener('mousedown', (e) => {
    holoSetCursorFromPoint(el, e.clientX, e.clientY);
    el.classList.add('is-pressed', 'is-hot');
    holoSchedule();
  });
  el.addEventListener('mouseup', () => {
    el.classList.remove('is-pressed');
    holoSchedule();
  });
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; if (!t) return;
    holoSetCursorFromPoint(el, t.clientX, t.clientY);
    el.classList.add('is-hot', 'is-pressed');
    holoSchedule();
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t) return;
    holoSetCursorFromPoint(el, t.clientX, t.clientY);
    holoSchedule();
  }, { passive: true });
  const endTouch = () => {
    if (el.__holoCursor) el.__holoCursor.active = false;
    el.classList.remove('is-hot', 'is-pressed');
    holoSchedule();
  };
  el.addEventListener('touchend', endTouch, { passive: true });
  el.addEventListener('touchcancel', endTouch, { passive: true });
  holoCards.add(el);
  holoEnsureListeners();
  holoSchedule();
}

/* When a post becomes visible to other students. Endo: 7 days before
 * the appointment at 8 AM. All other procedures: 8 AM the previous day.
 * Returns a Date in local time. */
function assistVisibilityStartMs(dateYmd, procedure) {
  const days = ASSIST_VISIBILITY_DAYS[procedure];
  if (days == null) return 0;
  const d = parseYmd(dateYmd);
  d.setDate(d.getDate() - days);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

function assistIsLiveToOthers(a, now) {
  const t = (now == null ? Date.now() : now);
  return t >= assistVisibilityStartMs(a.date, a.procedure);
}

function assistAvailableTimes(dateYmd) {
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return ASSIST_TIME_DEFAULT;
  return parseYmd(dateYmd).getDay() === 1 ? ASSIST_TIME_MONDAY : ASSIST_TIME_DEFAULT;
}

async function postAssistDoc(assist) {
  if (!state.firestoreReady) { toast('Data storage is not configured yet.'); return false; }
  await db.collection('assists').add(assist);
  return true;
}

async function deleteAssistDoc(id) {
  if (!state.firestoreReady) return false;
  await db.collection('assists').doc(id).delete();
  return true;
}

async function propagateProfileToAssists(profile) {
  // Mirror propagateProfileToBlocks: only updates assists currently in our
  // local cache (i.e. the user is on the Assist tab when they edit profile).
  // Assists are short-lived (auto-drop by date), so we accept that posts
  // outside the cache keep stale contact info until they expire.
  if (!state.firestoreReady) return;
  const mine = state.assists.filter((a) => a.sNumber === profile.sNumber);
  if (mine.length === 0) return;
  const batch = db.batch();
  for (const a of mine) {
    batch.update(db.collection('assists').doc(a.id), {
      name: profile.name,
      phone: profile.phone,
    });
  }
  await batch.commit();
}

/* ----------------------------- admin gate ----------------------------- */

async function pbkdf2Hex(text, salt, iterations) {
  if (!window.crypto || !window.crypto.subtle) return '';
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* Checks the URL for ?adminkey=...; if provided, signs in anonymously
 * so we can read the auth-gated config/admin doc, then compares hashes.
 * The hash lives in Firestore (not in this file) so view-source can't
 * expose it to casual readers. */
async function maybeBootstrapAdmin() {
  const url = new URL(location.href);
  const key = url.searchParams.get('adminkey');
  if (key) {
    url.searchParams.delete('adminkey');
    history.replaceState({}, '', url.toString());
    try {
      await ensureAnonAuth();
      if (!state.firestoreReady) { toast('Data storage not ready.'); }
      else {
        const snap = await db.collection('config').doc('admin').get();
        const expected = snap.exists ? snap.data().hash : null;
        if (!expected) {
          toast('Admin config missing in Firestore.');
        } else {
          const actual = await pbkdf2Hex(key, ADMIN_KDF_SALT, ADMIN_KDF_ITERATIONS);
          if (actual === expected) {
            localStorage.setItem(ADMIN_FLAG_KEY, '1');
            toast('Admin unlocked on this browser.');
          } else {
            toast('Wrong admin key.');
          }
        }
      }
    } catch (err) {
      console.error('Admin bootstrap failed:', err);
      logClientError('admin-bootstrap', err);
      toast('Admin unlock failed.');
    }
  }
  refreshAdminState();
}

/* Recomputes whether the admin UI should be visible. Admin requires
 * three things at once: a live auth session, the per-browser unlock
 * flag (set by ?adminkey=), AND the signed-in profile's S# matches
 * ADMIN_SNUMBER. Any of those missing and the admin class is stripped. */
function refreshAdminState() {
  const authed = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
  const flag = localStorage.getItem(ADMIN_FLAG_KEY) === '1';
  const correctUser = !!(state.profile && state.profile.sNumber === ADMIN_SNUMBER);
  state.isAdmin = !!(authed && flag && correctUser);
  document.body.classList.toggle('admin', state.isAdmin);
}

function forgetAdmin() {
  localStorage.removeItem(ADMIN_FLAG_KEY);
  state.isAdmin = false;
  document.body.classList.remove('admin');
  toast('Admin access removed from this browser.');
  if (state.view === 'admin') setView('calendar');
}

/* ----------------------------- anon auth ----------------------------- */

/* Firebase Anonymous Auth. Used as a lightweight "someone is using the
 * real app" marker so Firestore rules can require request.auth != null
 * for reads — this blocks direct REST scraping without having to run
 * the full client. It is NOT user-level auth (anyone can get an anon
 * token), but paired with App Check it meaningfully raises the bar.
 *
 * If it fails (e.g. anon sign-in not enabled yet in the Firebase
 * console, or reCAPTCHA blocked), we bail out to the sign-in screen
 * via handleAuthLoss — rules will reject every read, so pretending
 * the app is usable would just show a broken UI. */
async function ensureAnonAuth() {
  if (typeof firebase === 'undefined' || !firebase.auth) return null;
  const auth = firebase.auth();
  if (auth.currentUser) return auth.currentUser;
  try {
    const cred = await auth.signInAnonymously();
    return cred.user;
  } catch (err) {
    console.warn('Anonymous sign-in failed — rules will reject reads:', err);
    logClientError('anon-auth', err);
    return null;
  }
}

/* Called whenever Firebase auth is null when it shouldn't be. Nukes
 * any lingering admin/profile state so non-admin UI isn't shown under
 * a broken session, then routes back to the sign-in gate. */
function handleAuthLoss(reason) {
  stopHeartbeat();
  state.sessionId = null;
  state.isAdmin = false;
  document.body.classList.remove('admin');
  clearLocalProfile();
  const el = document.getElementById('signin-gate');
  if (el) showSignIn();
  if (reason) toast(reason);
}

/* ----------------------------- sessions ----------------------------- */

/* Tracks sign-in sessions so the admin view can show usage frequency,
 * total time, and who is online right now. Writes are kept cheap:
 * one create on sign-in, one update every 5 min while the tab is
 * visible, one final update on unload. Hidden tabs stop heart-
 * beating so an idle browser costs nothing. */
async function startSession() {
  if (!state.firestoreReady || !state.profile) return;
  try {
    const ref = await db.collection('sessions').add({
      sNumber: state.profile.sNumber,
      startedAt: Date.now(),
      lastActive: Date.now(),
    });
    state.sessionId = ref.id;
  } catch (err) {
    logClientError('session-start', err);
    return;
  }
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

async function heartbeat() {
  if (!state.firestoreReady || !state.sessionId) return;
  try {
    await db.collection('sessions').doc(state.sessionId).update({
      lastActive: Date.now(),
    });
  } catch (_) { /* best-effort */ }
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

async function endSession() {
  stopHeartbeat();
  await heartbeat();
  state.sessionId = null;
}

/* Log a client-side error to Firestore so the site owner can diagnose
 * issues without asking the user to open DevTools. Best-effort: if the
 * write itself fails (e.g. App Check blocked, offline), we give up
 * silently rather than loop. */
async function logClientError(context, err) {
  try {
    if (!state.firestoreReady || !db) return;
    const sNumber =
      state.pendingSNumber ||
      (state.profile && state.profile.sNumber) ||
      null;
    await db.collection('clientErrors').add({
      context: String(context || 'unknown').slice(0, 60),
      message: String((err && err.message) || err || '').slice(0, 500),
      code: err && err.code ? String(err.code).slice(0, 60) : '',
      sNumber: sNumber ? String(sNumber).slice(0, 6) : '',
      userAgent: String(navigator.userAgent || '').slice(0, 300),
      url: String(location.href || '').slice(0, 200),
      timestamp: Date.now(),
    });
  } catch (_) {
    /* swallow — never loop on the error path */
  }
}

function createUrgentToggleBtn(block) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'urgent-toggle-btn' + (block.urgent ? ' active' : '');
  btn.textContent = '!';
  const label = block.urgent ? 'Currently urgent — click to clear' : 'Mark urgent';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await setBlockUrgent(block.id, !block.urgent);
      toast(block.urgent ? 'Urgency cleared.' : 'Marked urgent.');
    } catch (e) {
      console.error(e);
      toast('Could not update urgency.');
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function showSetupWarning() {
  const gate = $('signin-gate');
  if (!gate) return;
  const warn = document.createElement('div');
  warn.className = 'empty-state';
  warn.style.marginBottom = '14px';
  warn.innerHTML =
    '<strong>Setup needed:</strong> this site needs a free Firebase project to share blocks between students. ' +
    'See <code>firebase-config.js</code> and the README for a 5-minute setup.';
  gate.prepend(warn);
}

/* ----------------------------- gate + views ----------------------------- */

function setGate(which) {
  // which: 'signin' | 'pin' | 'setup' | null
  $('signin-gate').classList.toggle('hidden', which !== 'signin');
  $('pin-gate').classList.toggle('hidden', which !== 'pin');
  $('setup-gate').classList.toggle('hidden', which !== 'setup');
}

function setView(view) {
  // Guest-only views available without sign-in.
  const publicViews = new Set(['costs']);
  if (!profileValid(state.profile) && !publicViews.has(view)) {
    showSignIn();
    return;
  }
  if (view === 'admin' && !state.isAdmin) { view = 'calendar'; }
  setGate(null);
  const prevView = state.view;
  state.view = view;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  $('view-calendar').classList.toggle('hidden', view !== 'calendar');
  $('view-my-blocks').classList.toggle('hidden', view !== 'my-blocks');
  $('view-post').classList.toggle('hidden', view !== 'post');
  $('view-assist').classList.toggle('hidden', view !== 'assist');
  $('view-costs').classList.toggle('hidden', view !== 'costs');
  $('view-profile').classList.toggle('hidden', view !== 'profile');
  const adminEl = $('view-admin');
  if (adminEl) adminEl.classList.toggle('hidden', view !== 'admin');
  // Subscribe to the assists collection only while the Assist tab is open.
  // Saves reads when nobody on the page cares.
  if (prevView === 'assist' && view !== 'assist') {
    unsubscribeAssists();
    stopAssistTick();
  }
  if (view === 'assist') {
    subscribeAssists();
    startAssistTick();
  }
  if (view === 'my-blocks') {
    // When nothing is imported yet, drop straight into edit mode so the user
    // sees the upload UI. Otherwise keep whatever mode they were last in.
    const mode = state.schedule.length === 0 ? 'edit' : state.myBlocksMode;
    setMyBlocksMode(mode);
    return;
  }
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'calendar') renderCalendar();
  else if (state.view === 'my-blocks') renderMyBlocksView();
  else if (state.view === 'assist') renderAssistView();
  else if (state.view === 'costs') renderProcedureCosts();
  else if (state.view === 'profile') fillProfileEditForm();
  else if (state.view === 'admin') enterAdminView();
}

function setMyBlocksMode(mode) {
  state.myBlocksMode = mode;
  $('my-blocks-display').classList.toggle('hidden', mode !== 'display');
  $('my-blocks-edit').classList.toggle('hidden', mode !== 'edit');
  renderMyBlocksView();
}

function renderMyBlocksView() {
  if (state.myBlocksMode === 'edit') {
    renderSchedule();
  } else {
    renderMyBlocks();
  }
}

function setAuthMode(signedIn) {
  document.body.classList.toggle('signed-in', !!signedIn);
  document.body.classList.toggle('signed-out', !signedIn);
}

function showApp() {
  setAuthMode(true);
  setGate(null);
  loadSchedule();
  handleReminderToggle();
  refreshAdminState();
  ensureAnonAuth().then(() => {
    if (!state.sessionId) startSession();
  });
  const knownViews = new Set(['calendar', 'my-blocks', 'post', 'assist', 'profile', 'admin']);
  setView(knownViews.has(state.view) ? state.view : 'calendar');
}

function showSignIn() {
  setAuthMode(false);
  refreshAdminState();
  setGate('signin');
  ['view-calendar', 'view-my-blocks', 'view-post', 'view-assist', 'view-costs', 'view-profile', 'view-admin'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  $('signin-snum').value = '';
  setTimeout(() => $('signin-snum').focus(), 50);
}

function showSetup(sNumber) {
  state.pendingSNumber = sNumber;
  setGate('setup');
  $('periomaxer-ad').classList.add('hidden');
  $('setup-snum-label').textContent = sNumber;
  $('setup-form').reset();
  setTimeout(() => $('setup-name').focus(), 50);
}

function showPinPrompt(sNumber) {
  state.pendingSNumber = sNumber;
  setGate('pin');
  $('periomaxer-ad').classList.add('hidden');
  $('pin-snum-label').textContent = sNumber;
  $('pin-form').reset();
  setTimeout(() => $('pin-input').focus(), 50);
}

/* ----------------------------- sign-in / setup ----------------------------- */

async function handleSignInSubmit(e) {
  e.preventDefault();
  if (!rateLimitOk('signIn')) { toast('Slow down — try again in a minute.'); return; }
  const snum = $('signin-snum').value.trim();
  if (!/^\d{5}$/.test(snum)) { toast('S# must be 5 digits.'); return; }
  const sNumber = 'S' + snum;

  if (!state.firestoreReady) {
    toast('Data storage is not configured yet. See README.');
    return;
  }

  const btn = $('signin-submit');
  btn.disabled = true;
  try {
    const user = await fetchUserDoc(sNumber);
    if (user && validName(user.name) && validPhoneOrEmpty(user.phone) && user.pinHash) {
      showPinPrompt(sNumber);
    } else {
      showSetup(sNumber);
    }
  } catch (err) {
    console.error(err);
    logClientError('sign-in-lookup', err);
    toast('Sign in failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

async function handlePinSubmit(e) {
  e.preventDefault();
  if (!rateLimitOk('signIn')) { toast('Slow down — try again in a minute.'); return; }
  const pin = $('pin-input').value;
  if (!validPin(pin)) { toast('PIN must be 4–6 digits.'); return; }
  const sNumber = state.pendingSNumber;
  if (!sNumber) { showSignIn(); return; }

  const btn = $('pin-submit');
  btn.disabled = true;
  try {
    const [user, hash] = await Promise.all([
      fetchUserDoc(sNumber),
      hashPin(sNumber, pin),
    ]);
    if (!user || !user.pinHash || user.pinHash !== hash) {
      toast('Incorrect PIN.');
      $('pin-input').select();
      return;
    }
    cacheProfile({ name: user.name, sNumber, phone: user.phone });
    toast('Welcome back, ' + user.name.split(' ')[0] + '.');
    state.pendingSNumber = null;
    showApp();
  } catch (err) {
    console.error(err);
    logClientError('pin-submit', err);
    toast('Sign in failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

function handlePinBack() {
  state.pendingSNumber = null;
  showSignIn();
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  if (!$('setup-agree').checked) { toast('Please agree to the privacy policy.'); return; }
  const name = $('setup-name').value.trim();
  const phone = $('setup-phone').value.trim();
  const pin = $('setup-pin').value;
  const pin2 = $('setup-pin2').value;
  if (!validName(name)) { toast('Enter your full name.'); return; }
  if (!validPhoneOrEmpty(phone)) { toast('Phone number needs 10 digits or leave it blank.'); return; }
  if (!validPin(pin)) { toast('PIN must be 4–6 digits.'); return; }
  if (pin !== pin2) { toast('PINs don’t match.'); return; }

  const sNumber = state.pendingSNumber;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const pinHash = await hashPin(sNumber, pin);
    const profile = { name, sNumber, phone };
    await createUserDoc({ ...profile, pinHash });
    cacheProfile(profile);
    toast('Account created — welcome, ' + name.split(' ')[0] + '.');
    state.pendingSNumber = null;
    showApp();
  } catch (err) {
    console.error(err);
    logClientError('account-create', err);
    const codeSuffix = err && err.code ? ' (' + err.code + ')' : '';
    toast('Could not create account' + codeSuffix + '. Check Firestore rules.');
  } finally {
    btn.disabled = false;
  }
}

function handleSetupBack() {
  state.pendingSNumber = null;
  showSignIn();
}

/* ----------------------------- calendar ----------------------------- */

function matchesFilters(block) {
  if (state.filterType && block.type !== state.filterType) return false;
  if (state.filterTime && block.time !== state.filterTime) return false;
  return true;
}

function blocksByDate() {
  const map = new Map();
  for (const b of state.blocks) {
    if (!matchesFilters(b)) continue;
    if (!map.has(b.date)) map.set(b.date, []);
    map.get(b.date).push(b);
  }
  return map;
}

function renderCalendar() {
  const root = $('calendar');
  root.innerHTML = '';
  const month = state.calMonth;
  $('cal-label').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDate = blocksByDate();
  const todayStr = ymd(new Date());

  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  const firstDow = firstOfMonth.getDay();
  let leadingEmpties = 0;
  if (firstDow === 0 || firstDow === 6) leadingEmpties = 5;
  else leadingEmpties = firstDow - 1;

  for (let i = 0; i < leadingEmpties; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    root.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue;

    const dstr = ymd(date);
    const list = byDate.get(dstr) || [];
    const hasUrgent = list.some((b) => b.urgent);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day' + (list.length === 0 ? ' has-none' : '') + (dstr === todayStr ? ' today' : '') + (hasUrgent ? ' has-urgent' : '');
    btn.dataset.date = dstr;

    const headRow = document.createElement('div');
    headRow.style.display = 'flex';
    headRow.style.justifyContent = 'space-between';
    headRow.style.alignItems = 'center';

    const num = document.createElement('span');
    num.className = 'date-num';
    num.textContent = String(d);
    headRow.appendChild(num);

    if (list.length > 0) {
      const pill = document.createElement('span');
      pill.className = 'count-pill';
      pill.textContent = String(list.length);
      pill.setAttribute('aria-label', list.length === 1 ? '1 block' : list.length + ' blocks');
      headRow.appendChild(pill);
    }
    if (hasUrgent) {
      const bang = document.createElement('span');
      bang.className = 'urgent-dot';
      bang.textContent = '!';
      bang.title = 'At least one urgent block';
      headRow.appendChild(bang);
    }
    btn.appendChild(headRow);

    if (list.length > 0) {
      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';
      if (list.some((b) => b.time === 'morning')) {
        const t = document.createElement('span'); t.className = 'tag morning'; t.textContent = 'AM'; tagRow.appendChild(t);
      }
      if (list.some((b) => b.time === 'afternoon')) {
        const t = document.createElement('span'); t.className = 'tag afternoon'; t.textContent = 'PM'; tagRow.appendChild(t);
      }
      btn.appendChild(tagRow);
    }

    btn.addEventListener('click', () => openDayDetail(dstr));
    root.appendChild(btn);
  }

  if (state.selectedDate) openDayDetail(state.selectedDate, { keepOpen: true });
}

function openDayDetail(dstr, opts = {}) {
  state.selectedDate = dstr;
  const list = (blocksByDate().get(dstr) || []).slice();
  list.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  $('day-detail').classList.remove('hidden');
  $('day-detail-title').textContent = `Blocks on ${prettyDate(dstr)}`;
  const listEl = $('day-detail-list');
  listEl.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No blocks posted for this day with your current filters.';
    listEl.appendChild(empty);
    return;
  }

  for (const b of list) {
    listEl.appendChild(renderBlockCard(b, { showContact: true }));
  }

  if (!opts.keepOpen) {
    $('day-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function closeDayDetail() {
  state.selectedDate = null;
  $('day-detail').classList.add('hidden');
}

function renderBlockCard(b, opts = {}) {
  const card = document.createElement('div');
  card.className = 'block-card' + (b.urgent ? ' urgent' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${b.type} — ${b.time === 'morning' ? 'Morning' : 'Afternoon'}`;
  if (b.urgent) {
    const badge = document.createElement('span');
    badge.className = 'urgent-badge';
    badge.textContent = 'Urgent';
    badge.title = 'Poster marked this block as urgent';
    title.appendChild(document.createTextNode(' '));
    title.appendChild(badge);
  }
  meta.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${prettyDate(b.date)} • Posted by ${b.name} (${b.sNumber})`;
  meta.appendChild(sub);
  card.appendChild(meta);

  if (opts.showContact) {
    const contact = document.createElement('div');
    contact.className = 'contact';
    if (hasPhone(b.phone)) {
      const phone = formatPhone(b.phone);
      contact.innerHTML = `<div>Contact:</div>
        <div><a href="${telHref(b.phone)}">${phone}</a></div>
        <div><a href="${smsHref(b.phone)}">Send text</a></div>`;
    } else {
      contact.innerHTML = `<div class="small muted">No phone on file — reach out via GroupMe.</div>`;
    }
    card.appendChild(contact);
  }

  if (opts.mine) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(createUrgentToggleBtn(b));
    const del = document.createElement('button');
    del.className = 'text-btn danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      if (!confirm('Remove this block from the calendar?')) return;
      try {
        await deleteBlockDoc(b.id);
        toast('Block removed.');
      } catch (e) {
        console.error(e);
        toast('Could not remove block.');
      }
    });
    actions.appendChild(del);
    card.appendChild(actions);
  }

  if (b.notes) {
    const n = document.createElement('div');
    n.className = 'notes';
    n.textContent = b.notes;
    card.appendChild(n);
  }

  return card;
}

/* ----------------------------- my blocks ----------------------------- */

function renderMyBlocks() {
  const listEl = $('my-blocks-list');
  listEl.innerHTML = '';
  if (!state.profile) return;

  if (state.schedule.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No schedule imported yet. Click “Edit schedule” above to upload your blocks, then come back here to post them.';
    listEl.appendChild(empty);
    return;
  }

  // Schedule entries with post/unpost controls
  for (const entry of state.schedule) {
    listEl.appendChild(renderScheduleRow(entry));
  }

  // Manually posted blocks not tied to an imported schedule entry
  const schedKeys = new Set(state.schedule.map((e) => {
    const p = startTimeToPeriod(e.startTime);
    return `${e.date}|${p}`;
  }));
  const orphans = state.blocks.filter((b) =>
    b.sNumber === state.profile.sNumber && !schedKeys.has(`${b.date}|${b.time}`)
  );
  for (const b of orphans) {
    listEl.appendChild(renderBlockCard(b, { mine: true }));
  }
}

/* ----------------------------- post form ----------------------------- */

function populateBlockTypeSelects() {
  const filterSel = $('filter-type');
  const adminFilterSel = $('admin-cal-filter-type');
  const postSel = $('post-type');
  for (const t of BLOCK_TYPES) {
    const o1 = document.createElement('option'); o1.value = t; o1.textContent = t; filterSel.appendChild(o1);
    if (adminFilterSel) {
      const oA = document.createElement('option'); oA.value = t; oA.textContent = t; adminFilterSel.appendChild(oA);
    }
    if (t === 'Hospital') continue;
    const o2 = document.createElement('option'); o2.value = t; o2.textContent = t; postSel.appendChild(o2);
  }
}

async function handlePostBlock(e) {
  e.preventDefault();
  if (!state.profile) { toast('Sign in first.'); return; }
  if (!rateLimitOk('post')) { toast('Too many posts — try again in a minute.'); return; }
  const date = $('post-date').value;
  const time = $('post-time').value;
  const type = $('post-type').value;
  const notes = $('post-notes').value.trim().slice(0, 200);

  if (!date || !time || !type) { toast('Please fill in every field.'); return; }
  if (!isWeekday(date)) { toast('Blocks are Monday–Friday only.'); return; }
  if (!BLOCK_TYPES.includes(type)) { toast('Unknown block type.'); return; }
  if (type === 'Hospital') { toast('Hospital blocks cannot be posted for swap.'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Invalid date.'); return; }

  // Reject posts more than 1 year in the past or 1 year in the future.
  const d = parseYmd(date);
  const today = new Date(); today.setHours(0,0,0,0);
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  if (Math.abs(d - today) > yearMs) { toast('Pick a date within a year.'); return; }

  const dup = state.blocks.some((b) =>
    b.sNumber === state.profile.sNumber && b.date === date && b.time === time
  );
  if (dup) { toast('You already posted that block.'); return; }

  const block = {
    date,
    time,
    type,
    notes: notes || null,
    name: state.profile.name,
    sNumber: state.profile.sNumber,
    phone: state.profile.phone,
    createdAt: Date.now(),
  };

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await postBlockDoc(block);
    $('post-form').reset();
    toast('Block posted.');
    setView('calendar');
  } catch (err) {
    console.error(err);
    logClientError('block-post', err);
    toast('Could not post block. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- account edit ----------------------------- */

function fillProfileEditForm() {
  if (!state.profile) return;
  $('account-snum-label').textContent = state.profile.sNumber;
  $('edit-name').value = state.profile.name;
  $('edit-phone').value = state.profile.phone;
}

async function handleProfileEditSubmit(e) {
  e.preventDefault();
  const name = $('edit-name').value.trim();
  const phone = $('edit-phone').value.trim();
  if (!validName(name)) { toast('Enter your full name.'); return; }
  if (!validPhoneOrEmpty(phone)) { toast('Phone number needs 10 digits or leave it blank.'); return; }

  const profile = { name, sNumber: state.profile.sNumber, phone };
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await updateUserDoc(profile);
    await propagateProfileToBlocks(profile).catch((err) => {
      console.warn('Could not propagate profile changes to existing blocks:', err);
    });
    await propagateProfileToAssists(profile).catch((err) => {
      console.warn('Could not propagate profile changes to existing assists:', err);
    });
    cacheProfile(profile);
    toast('Account updated.');
  } catch (err) {
    console.error(err);
    logClientError('account-update', err);
    toast('Could not save changes.');
  } finally {
    btn.disabled = false;
  }
}

function handleSignOut() {
  if (!confirm('Sign out? Your posted blocks stay on the calendar.')) return;
  endSession();
  clearLocalProfile();
  showSignIn();
}

/* ----------------------------- schedule: parsing ----------------------------- */

function parseTime12(str) {
  const m = (str || '').trim().match(/^(\d{1,2}):(\d{2})\s*([APap][Mm])\.?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  if (h === 12) h = 0;
  if (ampm === 'PM') h += 12;
  return { h, min, display: `${pad2(parseInt(m[1],10))}:${pad2(min)} ${ampm}` };
}

function parseMmDdYyyy(str) {
  const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yyyy = parseInt(m[3], 10);
  if (yyyy < 100) yyyy += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { yyyy, mm, dd, ymd: `${yyyy}-${pad2(mm)}-${pad2(dd)}`, display: `${pad2(mm)}/${pad2(dd)}/${yyyy}` };
}

function cleanDescription(raw) {
  // Strip OCR junk that sometimes leaks in front of the @ marker
  // ("| @BLK-PAN", "|| @BLK-PAN" — pipe characters from misread table borders),
  // then drop the @ itself.
  const stripped = (raw || '')
    .trim()
    .replace(/^[^A-Za-z@]+/, '')
    .replace(/^@+/, '')
    .trim();
  const upper = stripped.toUpperCase();
  if (SCHEDULE_NAME_MAP[upper]) return SCHEDULE_NAME_MAP[upper];
  // Fuzzy fallback: if a known code appears anywhere in the string (handles
  // OCR artifacts like extra trailing whitespace or columns that got glued
  // onto the description, or stray leading letters like "GBLKONCALL").
  for (const code of Object.keys(SCHEDULE_NAME_MAP)) {
    if (upper.includes(code)) return SCHEDULE_NAME_MAP[code];
  }
  if (upper.includes('HOSP')) return 'HOSPITAL BLOCK';
  return stripped;
}

/* Parse a chunk of schedule text. Accepts:
 *   - Short CSV:   desc, MM/DD/YYYY, H:MM AM, H:MM PM
 *   - axiUm table: desc  start_date  end_date  from  to  weekdays  recur
 *   - OCR-style whitespace output with extra trailing columns.
 * Strategy: for each line, find the first MM/DD/YYYY pattern and the first
 * two H:MM AM/PM patterns. Everything before the first date is the
 * description; extra trailing columns (weekdays, recur) are ignored. */
function parseScheduleText(text) {
  const entries = [];
  const errors = [];
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
  const TIME_RE = /\b(\d{1,2}:\d{2}\s*[APap][Mm])\b/g;
  const HEADER_RE = /^(description|desc|block|name|event|start|end|from|to|weekdays?|recur)\b/i;

  for (const line of lines) {
    if (HEADER_RE.test(line)) continue;

    DATE_RE.lastIndex = 0;
    TIME_RE.lastIndex = 0;
    const dates = [];
    let m;
    while ((m = DATE_RE.exec(line)) !== null) dates.push({ str: m[1], index: m.index });
    const times = [];
    while ((m = TIME_RE.exec(line)) !== null) times.push({ str: m[1], index: m.index });

    if (dates.length === 0 || times.length < 2) {
      // Fall back to a strict CSV parse for the Python-script format.
      const parts = line.split(/\s*,\s*/).filter(Boolean);
      if (parts.length >= 4) {
        const d = parseMmDdYyyy(parts[1]);
        const s = parseTime12(parts[2]);
        const e = parseTime12(parts[3]);
        if (d && s && e && (e.h * 60 + e.min) > (s.h * 60 + s.min)) {
          entries.push(buildEntry(parts[0], d, s, e));
          continue;
        }
      }
      errors.push(line);
      continue;
    }

    const date = parseMmDdYyyy(dates[0].str);
    const start = parseTime12(times[0].str);
    const end = parseTime12(times[1].str);
    const descRaw = line.slice(0, dates[0].index).replace(/[,\s]+$/, '').trim();

    if (!date || !start || !end || !descRaw) { errors.push(line); continue; }
    if ((end.h * 60 + end.min) <= (start.h * 60 + start.min)) { errors.push(line); continue; }

    entries.push(buildEntry(descRaw, date, start, end));
  }

  return { entries, errors };
}

function buildEntry(descRaw, date, start, end) {
  return {
    id: 'sch_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    description: cleanDescription(descRaw),
    date: date.ymd,
    dateDisplay: date.display,
    startTime: start.display,
    endTime: end.display,
  };
}

function startTimeToPeriod(startDisplay) {
  const t = parseTime12(startDisplay);
  if (!t) return null;
  return t.h < 12 ? 'morning' : 'afternoon';
}

/* ----------------------------- schedule: storage ----------------------------- */

function scheduleKey() {
  if (!state.profile) return null;
  return SCHEDULE_KEY_PREFIX + state.profile.sNumber;
}

// Re-run cleanDescription over already-imported entries so fixes added to
// the OCR mis-scan map (e.g. "BLK-5PC&G", "GBLKONCALL") get applied to
// schedules that were imported before the fix shipped. Idempotent:
// canonical descriptions like "ORAL SURGERY BLOCK" pass through unchanged.
function migrateScheduleDescriptions(entries) {
  if (!Array.isArray(entries)) return false;
  let changed = false;
  for (const e of entries) {
    if (!e || typeof e.description !== 'string') continue;
    const cleaned = cleanDescription(e.description);
    if (cleaned !== e.description) {
      e.description = cleaned;
      changed = true;
    }
  }
  return changed;
}

function loadSchedule() {
  const key = scheduleKey();
  if (!key) { state.schedule = []; return; }
  try {
    const raw = localStorage.getItem(key);
    state.schedule = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.schedule = [];
  }
  if (migrateScheduleDescriptions(state.schedule)) saveSchedule();
  // Sync with Firestore in background. If the cloud has a schedule, pull it
  // down. Otherwise, if we have a local schedule, push it up (this handles
  // users who imported before schedule-sync existed).
  if (state.firestoreReady && state.profile) {
    db.collection('users').doc(state.profile.sNumber).get().then((snap) => {
      const cloud = snap.exists && Array.isArray(snap.data().schedule) ? snap.data().schedule : [];
      if (cloud.length > 0) {
        state.schedule = cloud;
        if (migrateScheduleDescriptions(state.schedule)) {
          saveSchedule();
        } else {
          localStorage.setItem(key, JSON.stringify(state.schedule));
        }
        if (state.view === 'schedule') renderSchedule();
      } else if (state.schedule.length > 0) {
        saveSchedule();
      }
    }).catch(() => {});
  }
}

function saveSchedule() {
  const key = scheduleKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(state.schedule));
  if (state.firestoreReady && state.profile) {
    db.collection('users').doc(state.profile.sNumber).update({
      schedule: state.schedule,
      updatedAt: Date.now(),
    }).catch(() => {});
  }
}

function mergeScheduleEntries(newEntries) {
  const dedupKey = (e) => `${e.date}|${e.startTime}|${e.endTime}|${e.description}`;
  const seen = new Set(state.schedule.map(dedupKey));
  let added = 0;
  for (const e of newEntries) {
    if (seen.has(dedupKey(e))) continue;
    seen.add(dedupKey(e));
    state.schedule.push(e);
    added++;
  }
  state.schedule.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.startTime || '').localeCompare(b.startTime || '');
  });
  saveSchedule();
  return added;
}

/* ----------------------------- schedule: OCR ----------------------------- */

let _tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractPromise) return _tesseractPromise;
  _tesseractPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.async = true;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { _tesseractPromise = null; reject(new Error('Could not load OCR library.')); };
    document.head.appendChild(s);
  });
  return _tesseractPromise;
}

async function ocrImage(file) {
  const Tesseract = await loadTesseract();
  const res = await Tesseract.recognize(file, 'eng');
  return (res && res.data && res.data.text) || '';
}

/* ----------------------------- schedule: ICS ----------------------------- */

function icsEscape(s) {
  return (s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function combineDateTime(ymdStr, timeDisplay) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const t = parseTime12(timeDisplay);
  if (!t) return null;
  return new Date(y, m - 1, d, t.h, t.min, 0);
}

function icsDateTime(dt) {
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;
}

function icsDateTimeUtc(dt) {
  return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`;
}

function uuidLike() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateIcs(events, personName, reminder) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ScheduleMaxer//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(personName)} Block Schedule`,
  ];

  const dtstamp = icsDateTimeUtc(new Date());
  const sorted = events.slice().sort((a, b) => {
    const da = combineDateTime(a.date, a.startTime);
    const db = combineDateTime(b.date, b.startTime);
    return da - db;
  });

  for (const ev of sorted) {
    const dtstart = combineDateTime(ev.date, ev.startTime);
    const dtend = combineDateTime(ev.date, ev.endTime);
    if (!dtstart || !dtend) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uuidLike()}@umsod-block-exchange`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${icsDateTime(dtstart)}`);
    lines.push(`DTEND:${icsDateTime(dtend)}`);
    lines.push(`SUMMARY:${icsEscape(ev.description)}`);
    lines.push(`DESCRIPTION:${icsEscape(ev.description + ' - ' + personName)}`);
    lines.push('STATUS:CONFIRMED');

    if (reminder && reminder.enabled) {
      const nightBefore = new Date(dtstart);
      nightBefore.setDate(nightBefore.getDate() - 1);
      nightBefore.setHours(reminder.hour, reminder.minute, 0, 0);
      const offsetSec = Math.max(0, Math.floor((dtstart - nightBefore) / 1000));
      const hours = Math.floor(offsetSec / 3600);
      const mins = Math.floor((offsetSec % 3600) / 60);
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${icsEscape('Reminder: ' + ev.description + ' tomorrow')}`);
      lines.push(`TRIGGER:-PT${hours}H${mins}M`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/* ----------------------------- schedule: view ----------------------------- */

function renderSchedule() {
  const listEl = $('schedule-list');
  listEl.innerHTML = '';
  const summary = $('schedule-summary');

  if (state.schedule.length === 0) {
    summary.textContent = 'Nothing imported yet.';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Import your schedule above to see your blocks here.';
    listEl.appendChild(empty);
    return;
  }
  summary.textContent = `${state.schedule.length} block${state.schedule.length === 1 ? '' : 's'} imported.`;

  for (const entry of state.schedule) {
    listEl.appendChild(renderScheduleRow(entry));
  }
}

function renderScheduleRow(entry) {
  const row = document.createElement('div');
  row.className = 'schedule-row';

  const period = startTimeToPeriod(entry.startTime);
  const type = DESC_TO_TYPE[entry.description.toUpperCase()] || null;
  const postedBlock = state.blocks.find((b) =>
    state.profile && b.sNumber === state.profile.sNumber &&
    b.date === entry.date && b.time === period
  );
  if (postedBlock) row.classList.add('posted');

  const dateEl = document.createElement('div');
  dateEl.className = 'sched-date';
  dateEl.textContent = prettyDate(entry.date).split(',').slice(0, 2).join(',');
  row.appendChild(dateEl);

  const timeEl = document.createElement('div');
  timeEl.className = 'sched-time';
  timeEl.textContent = `${entry.startTime} – ${entry.endTime}`;
  row.appendChild(timeEl);

  const descEl = document.createElement('div');
  descEl.className = 'sched-desc';
  descEl.textContent = entry.description;
  row.appendChild(descEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'sched-status';
  if (postedBlock) {
    const badge = document.createElement('span');
    badge.className = 'posted-badge';
    badge.textContent = 'Posted';
    statusEl.appendChild(badge);
    if (postedBlock.urgent) {
      row.classList.add('urgent');
      const urgentBadge = document.createElement('span');
      urgentBadge.className = 'urgent-badge';
      urgentBadge.textContent = 'Urgent';
      statusEl.appendChild(urgentBadge);
    }
  }
  row.appendChild(statusEl);

  const actions = document.createElement('div');
  actions.className = 'sched-actions';

  if (type && period) {
    if (postedBlock) {
      actions.appendChild(createUrgentToggleBtn(postedBlock));
      const unpost = document.createElement('button');
      unpost.type = 'button';
      unpost.className = 'text-btn danger';
      unpost.textContent = 'Unpost';
      unpost.addEventListener('click', async () => {
        if (!confirm('Remove this block from the public calendar?')) return;
        try {
          await deleteBlockDoc(postedBlock.id);
          toast('Block unposted.');
        } catch (e) {
          console.error(e);
          toast('Could not unpost.');
        }
      });
      actions.appendChild(unpost);
    } else {
      const post = document.createElement('button');
      post.type = 'button';
      post.className = 'text-btn';
      post.textContent = 'Post for swap';
      post.addEventListener('click', () => postScheduleEntry(entry, type, period, post));
      actions.appendChild(post);
    }
  } else {
    const note = document.createElement('span');
    note.className = 'small muted';
    note.textContent = 'Unknown block type';
    actions.appendChild(note);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-btn';
  remove.textContent = 'Remove';
  remove.title = 'Remove from your schedule (doesn’t affect anything on the calendar)';
  remove.addEventListener('click', () => {
    state.schedule = state.schedule.filter((x) => x.id !== entry.id);
    saveSchedule();
    renderSchedule();
  });
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

async function postScheduleEntry(entry, type, period, btn) {
  if (!state.profile) { toast('Sign in first.'); return; }
  if (type === 'Hospital') { toast('Hospital blocks cannot be posted for swap.'); return; }
  if (!rateLimitOk('post')) { toast('Too many posts — try again in a minute.'); return; }
  if (!isWeekday(entry.date)) { toast('Blocks are Monday–Friday only.'); return; }

  const block = {
    date: entry.date,
    time: period,
    type,
    notes: `${entry.startTime} – ${entry.endTime}`,
    name: state.profile.name,
    sNumber: state.profile.sNumber,
    phone: state.profile.phone,
    createdAt: Date.now(),
  };

  btn.disabled = true;
  try {
    await postBlockDoc(block);
    toast(`Posted: ${entry.description} on ${entry.dateDisplay}.`);
  } catch (err) {
    console.error(err);
    toast('Could not post. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- schedule: import handlers ----------------------------- */

async function handleScreenshotUpload(e) {
  const files = Array.from(e.target.files || []);
  await processScreenshotFiles(files);
  e.target.value = '';
}

async function processScreenshotFiles(files) {
  if (files.length === 0) return;
  const status = $('import-status');
  status.textContent = 'Loading OCR engine (first time only, ~10 MB)…';
  let totalAdded = 0;
  let totalErrors = 0;
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) status.textContent = `Processing image ${i + 1} of ${files.length}…`;
    let text;
    try {
      text = await ocrImage(files[i]);
    } catch (err) {
      console.error('OCR failed on image', i + 1, err);
      status.textContent = `OCR failed on image ${i + 1}.`;
      return;
    }
    console.log(`[Schedule OCR] Image ${i + 1} raw text:\n${text}`);
    const { entries, errors } = parseScheduleText(text);
    console.log(`[Schedule parser] Image ${i + 1}:`, entries, errors.length ? errors : '(no errors)');
    const added = mergeScheduleEntries(entries);
    totalAdded += added;
    totalErrors += errors.length;
    renderSchedule();
  }
  const parts = [`Added ${totalAdded} block${totalAdded === 1 ? '' : 's'}.`];
  if (totalErrors) parts.push(`${totalErrors} line${totalErrors === 1 ? '' : 's'} couldn’t be parsed.`);
  status.textContent = parts.join(' ');
}

function handleScheduleClear() {
  if (state.schedule.length === 0) return;
  if (!confirm('Clear your entire imported schedule? This will remove it from all your devices.')) return;
  state.schedule = [];
  saveSchedule();
  renderSchedule();
  toast('Schedule cleared.');
}

function handleReminderToggle() {
  const enabled = $('reminder-enabled').checked;
  $('reminder-time-label').style.opacity = enabled ? '1' : '0.4';
  $('reminder-time').disabled = !enabled;
}

function handleDownloadIcs() {
  if (!state.profile) { toast('Sign in first.'); return; }
  if (state.schedule.length === 0) { toast('Nothing to download — import a schedule first.'); return; }
  const enabled = $('reminder-enabled').checked;
  let reminder = null;
  if (enabled) {
    const v = ($('reminder-time').value || '19:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!v) { toast('Invalid reminder time.'); return; }
    const hour = parseInt(v[1], 10);
    const minute = parseInt(v[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) { toast('Invalid reminder time.'); return; }
    reminder = { enabled: true, hour, minute };
  }
  const ics = generateIcs(state.schedule, state.profile.name, reminder);
  const safeName = state.profile.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'blocks';
  downloadBlob(`${safeName}_Blocks.ics`, ics, 'text/calendar');
  toast('Calendar file downloaded.');
}

/* ----------------------------- assist view ----------------------------- */

function renderAssistView() {
  setAssistTab(state.assistTab || 'board');
}

function setAssistTab(tab) {
  if (!['board', 'mine', 'post'].includes(tab)) tab = 'board';
  state.assistTab = tab;
  document.querySelectorAll('#view-assist .assist-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.assistTab === tab);
  });
  $('assist-pane-board').classList.toggle('hidden', tab !== 'board');
  $('assist-pane-mine').classList.toggle('hidden', tab !== 'mine');
  $('assist-pane-post').classList.toggle('hidden', tab !== 'post');
  if (tab === 'board') renderAssistBoard();
  else if (tab === 'mine') renderAssistMine();
  else if (tab === 'post') initAssistPostForm();
}

/* Light timer that re-renders the visible board once a minute. Visibility
 * opens at fixed wall-clock times (8 AM day-of), so a user who lingers on
 * the page through that boundary should see new posts surface without
 * needing to navigate away. Cheap (no extra Firestore reads). */
function startAssistTick() {
  stopAssistTick();
  state.assistTickTimer = setInterval(() => {
    if (state.view !== 'assist') return;
    if (state.assistTab === 'board') renderAssistBoard();
    else if (state.assistTab === 'mine') renderAssistMine();
  }, 60 * 1000);
}

function stopAssistTick() {
  if (state.assistTickTimer) {
    clearInterval(state.assistTickTimer);
    state.assistTickTimer = null;
  }
}

function assistMatchesFilter(a) {
  if (state.assistFilterProcedure && a.procedure !== state.assistFilterProcedure) return false;
  return true;
}

function renderAssistBoard() {
  const todayStr = ymd(new Date());
  const now = Date.now();
  const filtered = state.assists.filter(assistMatchesFilter);
  const todayList = filtered
    .filter((a) => a.date === todayStr)
    .sort(compareAssistsForBoard);
  // Upcoming posts are visible to everyone once their per-procedure window
  // has opened (Endo: 7d ahead, others: 1d ahead). Posts beyond that window
  // are not yet "live" and only appear in the poster's "My posts" tab.
  const upcomingList = filtered
    .filter((a) => a.date > todayStr)
    .filter((a) => assistIsLiveToOthers(a, now))
    .sort(compareAssistsForBoard);
  renderAssistList($('assist-today-list'), todayList, {
    emptyMsg: 'No assist requests for today.',
    showContact: true,
  });
  renderAssistList($('assist-upcoming-list'), upcomingList, {
    emptyMsg: 'Nothing open yet \u2014 Endo opens 1 week ahead, others 1 day ahead, both at 8 AM.',
    showContact: true,
  });
}

function renderAssistList(host, items, opts) {
  host.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = opts.emptyMsg || 'Nothing here.';
    host.appendChild(empty);
    return;
  }
  for (const a of items) host.appendChild(renderAssistCard(a, opts));
}

function renderAssistMine() {
  const host = $('assist-mine-list');
  host.innerHTML = '';
  if (!state.profile) return;
  const mine = state.assists
    .filter((a) => a.sNumber === state.profile.sNumber)
    .sort(compareAssists);
  if (mine.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'You haven\u2019t posted any assist requests yet.';
    host.appendChild(empty);
    return;
  }
  for (const a of mine) host.appendChild(renderAssistCard(a, { mine: true }));
}

function renderAssistCard(a, opts) {
  const opt = opts || {};
  const isLive = assistIsLiveToOthers(a);
  const card = document.createElement('div');
  card.className = 'block-card assist-card' + (opt.mine && !isLive ? ' scheduled-only' : '');
  if (a.sNumber === ADMIN_SNUMBER) attachHolo(card);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  const timeLabel = ASSIST_TIME_LABEL[a.time] || a.time;
  title.appendChild(document.createTextNode(`${a.procedure} \u2014 ${timeLabel}`));
  if (a.chair) {
    const pill = document.createElement('span');
    pill.className = 'chair-pill';
    pill.textContent = `Chair ${a.chair}`;
    title.appendChild(pill);
  }
  meta.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${prettyDate(a.date)} \u2022 Posted by ${a.name} (${a.sNumber})`;
  meta.appendChild(sub);
  card.appendChild(meta);

  if (opt.showContact) {
    const contact = document.createElement('div');
    contact.className = 'contact';
    if (hasPhone(a.phone)) {
      const phone = formatPhone(a.phone);
      contact.innerHTML = `<div>Contact:</div>
        <div><a href="${telHref(a.phone)}">${phone}</a></div>
        <div><a href="${smsHref(a.phone)}">Send text</a></div>`;
    } else {
      contact.innerHTML = `<div class="small muted">No phone on file \u2014 reach out via GroupMe.</div>`;
    }
    card.appendChild(contact);
  }

  if (opt.mine) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'text-btn danger';
    del.textContent = 'Cancel';
    del.addEventListener('click', async () => {
      if (!confirm('Cancel this assist request?')) return;
      try {
        await deleteAssistDoc(a.id);
        toast('Request cancelled.');
      } catch (e) {
        console.error(e);
        toast('Could not cancel request.');
      }
    });
    actions.appendChild(del);
    card.appendChild(actions);
  }

  if (a.notes) {
    const n = document.createElement('div');
    n.className = 'notes';
    n.textContent = a.notes;
    card.appendChild(n);
  }

  if (opt.mine && !isLive) {
    const start = new Date(assistVisibilityStartMs(a.date, a.procedure));
    const note = document.createElement('div');
    note.className = 'notes visibility-note';
    note.textContent = `Visible to others starting ${start.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })}.`;
    card.appendChild(note);
  }

  return card;
}

function initAssistPostForm() {
  populateAssistTimeSelect();
}

function populateAssistTimeSelect() {
  const sel = $('assist-time');
  if (!sel) return;
  const dateVal = $('assist-date').value;
  const times = assistAvailableTimes(dateVal);
  const prev = sel.value;
  sel.innerHTML = '<option value="">Select\u2026</option>';
  for (const t of times) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = ASSIST_TIME_LABEL[t];
    sel.appendChild(opt);
  }
  if (times.includes(prev)) sel.value = prev;
}

async function handleAssistPostSubmit(e) {
  e.preventDefault();
  if (!state.profile) { toast('Sign in first.'); return; }
  if (!rateLimitOk('post')) { toast('Too many posts \u2014 try again in a minute.'); return; }

  const procedure = $('assist-procedure').value;
  const date = $('assist-date').value;
  const time = $('assist-time').value;
  const chair = $('assist-chair').value.trim().slice(0, 10);
  const notes = $('assist-notes').value.trim().slice(0, 200);

  if (!procedure || !date || !time) { toast('Please fill in every required field.'); return; }
  if (!ASSIST_PROCEDURES.includes(procedure)) { toast('Unknown procedure type.'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Invalid date.'); return; }
  if (!isWeekday(date)) { toast('Pick a weekday.'); return; }
  if (!assistAvailableTimes(date).includes(time)) {
    toast('That time isn\u2019t offered on the chosen day.');
    return;
  }

  const d = parseYmd(date);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d < today) { toast('Pick today or a future date.'); return; }
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  if ((d - today) > yearMs) { toast('Pick a date within a year.'); return; }

  const dup = state.assists.some((a) =>
    a.sNumber === state.profile.sNumber && a.date === date && a.time === time
  );
  if (dup) { toast('You already posted that slot.'); return; }

  const data = {
    procedure,
    date,
    time,
    chair: chair || null,
    notes: notes || null,
    name: state.profile.name,
    sNumber: state.profile.sNumber,
    phone: state.profile.phone,
    createdAt: Date.now(),
  };

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await postAssistDoc(data);
    e.target.reset();
    populateAssistTimeSelect();
    toast('Assist request posted.');
    setAssistTab('mine');
  } catch (err) {
    console.error(err);
    logClientError('assist-post', err);
    const codeSuffix = err && err.code ? ` (${err.code})` : '';
    toast(`Could not post request${codeSuffix}.`);
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- procedure costs ----------------------------- */

function formatMoney(n) {
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Format a cost cell. We use $0 fees as a sentinel for "fee unknown / not in
 * our reference" so students aren't misled into quoting a free service.
 * Reporting codes that really are billed at $0 keep their $0.00 display. */
function formatCostCell(amount, frequency) {
  if (amount > 0) return formatMoney(amount);
  if (/Reporting code/i.test(frequency || '')) return formatMoney(0);
  return 'Unknown';
}

function renderProcedureCosts() {
  const tbody = $('costs-tbody');
  if (!tbody) return;
  const q = ($('costs-filter').value || '').trim().toLowerCase();
  tbody.innerHTML = '';

  const showUnknown = $('costs-show-unknown')?.checked;
  const rows = PROCEDURE_COSTS.filter(([code, desc, fee, insurance, patient, frequency]) => {
    if (!showUnknown && formatCostCell(fee, frequency) === 'Unknown') return false;
    if (!q) return true;
    return code.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  });

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-cell';
    td.textContent = 'No procedures match that search.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const [code, desc, fee, insurance, patient, frequency, preAuth] of rows) {
    const tr = document.createElement('tr');
    const c = document.createElement('td'); c.textContent = code; c.className = 'code'; tr.appendChild(c);
    const d = document.createElement('td'); d.textContent = desc; tr.appendChild(d);
    const feeText = formatCostCell(fee, frequency);
    const unknown = feeText === 'Unknown';
    const f = document.createElement('td'); f.textContent = feeText; f.className = 'num' + (unknown ? ' unknown' : ''); tr.appendChild(f);
    const i = document.createElement('td'); i.textContent = unknown ? 'Unknown' : formatMoney(insurance); i.className = 'num' + (unknown ? ' unknown' : ''); tr.appendChild(i);
    const p = document.createElement('td'); p.textContent = unknown ? 'Unknown' : formatMoney(patient); p.className = 'num' + (unknown ? ' unknown' : ''); tr.appendChild(p);
    const q = document.createElement('td'); q.textContent = frequency || '—'; q.className = 'freq'; tr.appendChild(q);
    const pa = document.createElement('td'); pa.className = 'preauth';
    if (preAuth === 'Yes') {
      const badge = document.createElement('span');
      badge.className = 'pa-badge';
      badge.textContent = 'Pre-auth';
      pa.appendChild(badge);
    } else {
      pa.textContent = '—';
    }
    tr.appendChild(pa);
    tbody.appendChild(tr);
  }
}

/* ----------------------------- admin view ----------------------------- */

async function enterAdminView() {
  if (!state.isAdmin) { setView('calendar'); return; }
  if (!state.admin.loaded) await loadAdminData();
  setAdminSubView(state.admin.subView || 'users');
}

/* One-shot fetches so the admin view doesn't pay for a live subscription
 * on potentially-large collections. A Refresh button re-runs this. */
async function loadAdminData() {
  if (!state.firestoreReady) {
    toast('Data storage not ready.');
    return;
  }
  const statusEl = $('admin-status');
  if (statusEl) statusEl.textContent = 'Loading…';
  try {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const [usersSnap, sessionsSnap, blocksSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('sessions').where('startedAt', '>=', thirtyDaysAgo).get(),
      db.collection('blocks').get(),
    ]);
    state.admin.users = [];
    usersSnap.forEach((doc) => state.admin.users.push({ id: doc.id, ...doc.data() }));
    state.admin.sessions = [];
    sessionsSnap.forEach((doc) => state.admin.sessions.push({ id: doc.id, ...doc.data() }));
    const posted = [];
    blocksSnap.forEach((doc) => posted.push({ id: doc.id, source: 'posted', ...doc.data() }));
    state.admin.postedCount = posted.length;
    // Fold every user's imported schedule into the admin block list so the
    // admin calendar shows everyone's full schedule, not just blocks posted
    // for swap. Dedupe against posted blocks (same student + date + period)
    // so a posted block doesn't appear twice.
    const postedKeys = new Set(posted.map((b) => `${b.sNumber}|${b.date}|${b.time}`));
    const scheduleBlocks = [];
    for (const u of state.admin.users) {
      if (!Array.isArray(u.schedule)) continue;
      for (const e of u.schedule) {
        const period = startTimeToPeriod(e.startTime);
        if (!e.date || !period) continue;
        const key = `${u.sNumber}|${e.date}|${period}`;
        if (postedKeys.has(key)) continue;
        // Pass description through cleanDescription on read so admin sees
        // fixed names for users whose stored schedule pre-dates a mis-scan
        // map update (their data will be migrated next time they sign in).
        const desc = cleanDescription(e.description || '');
        const type = DESC_TO_TYPE[desc.toUpperCase()] || desc || '—';
        scheduleBlocks.push({
          id: 'sched:' + u.sNumber + ':' + (e.id || `${e.date}-${e.startTime}`),
          source: 'schedule',
          date: e.date,
          time: period,
          type,
          notes: `${e.startTime || ''}${e.endTime ? ' – ' + e.endTime : ''}`.trim(),
          name: u.name,
          sNumber: u.sNumber,
          phone: u.phone,
        });
      }
    }
    state.admin.scheduleCount = scheduleBlocks.length;
    state.admin.allBlocks = posted.concat(scheduleBlocks);
    state.admin.loaded = true;
    if (statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error(err);
    logClientError('admin-load', err);
    toast('Could not load admin data.');
    if (statusEl) statusEl.textContent = 'Load failed.';
  }
}

function setAdminSubView(sub) {
  state.admin.subView = sub;
  document.querySelectorAll('#view-admin .admin-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.adminTab === sub);
  });
  $('admin-pane-users').classList.toggle('hidden', sub !== 'users');
  $('admin-pane-calendar').classList.toggle('hidden', sub !== 'calendar');
  if (sub === 'users') renderAdminUsers();
  else if (sub === 'calendar') {
    if (!state.admin.calMonth) {
      state.admin.calMonth = new Date();
      state.admin.calMonth.setDate(1);
    }
    populateAdminUserFilter();
    renderAdminCalendar();
  }
}

function aggregateSessions(sNumber) {
  const mine = state.admin.sessions.filter((s) => s.sNumber === sNumber);
  let total = 0;
  let latest = 0;
  for (const s of mine) {
    const dur = Math.max(0, (s.lastActive || s.startedAt) - s.startedAt);
    total += dur;
    if ((s.lastActive || s.startedAt) > latest) latest = s.lastActive || s.startedAt;
  }
  return {
    count: mine.length,
    totalMs: total,
    lastSeenAt: latest,
    online: latest > 0 && (Date.now() - latest) < ONLINE_WINDOW_MS,
  };
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0m';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return hours + 'h ' + rem + 'm';
}

function formatRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + 'h ago';
  const days = Math.floor(diff / 86400000);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function renderAdminUsers() {
  const root = $('admin-users-list');
  root.innerHTML = '';
  const users = [...state.admin.users].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const onlineCount = users.filter((u) => aggregateSessions(u.sNumber).online).length;
  $('admin-stat-total').textContent = String(users.length);
  $('admin-stat-online').textContent = String(onlineCount);
  $('admin-stat-blocks').textContent = String(state.admin.postedCount || 0);
  const schedEl = $('admin-stat-schedule');
  if (schedEl) schedEl.textContent = String(state.admin.scheduleCount || 0);
  if (users.length === 0) {
    root.innerHTML = '<div class="empty-state">No users yet.</div>';
    return;
  }
  for (const u of users) {
    const agg = aggregateSessions(u.sNumber);
    const row = document.createElement('div');
    row.className = 'admin-user-row' + (state.admin.selectedUser === u.sNumber ? ' expanded' : '');
    row.dataset.snum = u.sNumber;
    row.innerHTML =
      '<div class="admin-user-main">' +
        '<div class="admin-user-name">' +
          '<span class="status-dot' + (agg.online ? ' online' : '') + '" title="' + (agg.online ? 'Currently signed in' : 'Offline') + '"></span>' +
          escapeHtml(u.name || '—') +
          ' <span class="muted small">' + escapeHtml(u.sNumber) + '</span>' +
        '</div>' +
        '<div class="admin-user-meta">' +
          '<span>Joined ' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—') + '</span>' +
          '<span>' + agg.count + ' session' + (agg.count === 1 ? '' : 's') + ' (30d)</span>' +
          '<span>' + formatDuration(agg.totalMs) + ' total</span>' +
          '<span>Seen ' + formatRelative(agg.lastSeenAt) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="admin-user-detail"></div>';
    row.querySelector('.admin-user-main').addEventListener('click', () => {
      state.admin.selectedUser = state.admin.selectedUser === u.sNumber ? null : u.sNumber;
      renderAdminUsers();
    });
    if (state.admin.selectedUser === u.sNumber) {
      renderAdminUserDetail(u, row.querySelector('.admin-user-detail'));
    }
    root.appendChild(row);
  }
}

function renderAdminUserDetail(user, host) {
  const mySessions = state.admin.sessions
    .filter((s) => s.sNumber === user.sNumber)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const myBlocks = state.admin.allBlocks
    .filter((b) => b.sNumber === user.sNumber && b.source === 'posted')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const myScheduled = state.admin.allBlocks
    .filter((b) => b.sNumber === user.sNumber && b.source === 'schedule')
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const parts = [];
  parts.push(
    '<div class="admin-user-detail-section">' +
      '<strong>Contact</strong><br>' +
      'Phone: ' + escapeHtml(user.phone || '—') + '<br>' +
      'Updated: ' + (user.updatedAt ? new Date(user.updatedAt).toLocaleString() : '—') +
    '</div>'
  );
  parts.push('<div class="admin-user-detail-section"><strong>Posted blocks (' + myBlocks.length + ')</strong>');
  if (myBlocks.length === 0) {
    parts.push('<div class="muted small">None.</div>');
  } else {
    parts.push('<ul class="admin-list">');
    for (const b of myBlocks.slice(0, 30)) {
      parts.push(
        '<li>' + escapeHtml(b.date) + ' ' + escapeHtml(b.time || '') + ' — ' + escapeHtml(b.type || '') +
        (b.urgent ? ' <span class="urgent-badge">urgent</span>' : '') +
        '</li>'
      );
    }
    if (myBlocks.length > 30) parts.push('<li class="muted small">… + ' + (myBlocks.length - 30) + ' more</li>');
    parts.push('</ul>');
  }
  parts.push('</div>');
  parts.push('<div class="admin-user-detail-section"><strong>Imported schedule (' + myScheduled.length + ')</strong>');
  if (myScheduled.length === 0) {
    parts.push('<div class="muted small">No schedule imported.</div>');
  } else {
    parts.push('<ul class="admin-list">');
    for (const b of myScheduled.slice(0, 60)) {
      parts.push(
        '<li>' + escapeHtml(b.date) + ' ' + escapeHtml(b.time || '') + ' — ' + escapeHtml(b.type || '') +
        (b.notes ? ' <span class="muted small">' + escapeHtml(b.notes) + '</span>' : '') +
        '</li>'
      );
    }
    if (myScheduled.length > 60) parts.push('<li class="muted small">… + ' + (myScheduled.length - 60) + ' more</li>');
    parts.push('</ul>');
  }
  parts.push('</div>');
  parts.push('<div class="admin-user-detail-section"><strong>Recent sessions (' + mySessions.length + ')</strong>');
  if (mySessions.length === 0) {
    parts.push('<div class="muted small">No sessions recorded in the last 30 days.</div>');
  } else {
    parts.push('<ul class="admin-list">');
    for (const s of mySessions.slice(0, 20)) {
      const dur = Math.max(0, (s.lastActive || s.startedAt) - s.startedAt);
      parts.push(
        '<li>' + new Date(s.startedAt).toLocaleString() + ' — ' + formatDuration(dur) + '</li>'
      );
    }
    if (mySessions.length > 20) parts.push('<li class="muted small">… + ' + (mySessions.length - 20) + ' more</li>');
    parts.push('</ul>');
  }
  parts.push('</div>');
  host.innerHTML = parts.join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function populateAdminUserFilter() {
  const sel = $('admin-cal-filter-user');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Everyone</option>';
  const sorted = [...state.admin.users].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const u of sorted) {
    const opt = document.createElement('option');
    opt.value = u.sNumber;
    opt.textContent = (u.name || '—') + ' (' + u.sNumber + ')';
    sel.appendChild(opt);
  }
  sel.value = prev || '';
}

function adminMatchesFilters(block) {
  if (state.admin.filterType && block.type !== state.admin.filterType) return false;
  if (state.admin.filterTime && block.time !== state.admin.filterTime) return false;
  if (state.admin.filterUser && block.sNumber !== state.admin.filterUser) return false;
  return true;
}

function renderAdminCalendar() {
  const root = $('admin-calendar');
  if (!root) return;
  root.innerHTML = '';
  const month = state.admin.calMonth;
  $('admin-cal-label').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDate = new Map();
  for (const b of state.admin.allBlocks) {
    if (!adminMatchesFilters(b)) continue;
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }

  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const firstDow = firstOfMonth.getDay();
  let leadingEmpties = 0;
  if (firstDow === 0 || firstDow === 6) leadingEmpties = 5;
  else leadingEmpties = firstDow - 1;
  for (let i = 0; i < leadingEmpties; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    root.appendChild(empty);
  }
  const todayStr = ymd(new Date());
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue;
    const dstr = ymd(date);
    const list = byDate.get(dstr) || [];
    const hasUrgent = list.some((b) => b.urgent);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day' + (list.length === 0 ? ' has-none' : '') + (dstr === todayStr ? ' today' : '') + (hasUrgent ? ' has-urgent' : '');
    btn.dataset.date = dstr;

    const headRow = document.createElement('div');
    headRow.style.display = 'flex';
    headRow.style.justifyContent = 'space-between';
    headRow.style.alignItems = 'center';
    const num = document.createElement('span');
    num.className = 'date-num';
    num.textContent = String(d);
    headRow.appendChild(num);
    if (list.length > 0) {
      const pill = document.createElement('span');
      pill.className = 'count-pill';
      pill.textContent = String(list.length);
      pill.setAttribute('aria-label', list.length + ' block' + (list.length === 1 ? '' : 's'));
      headRow.appendChild(pill);
    }
    if (hasUrgent) {
      const bang = document.createElement('span');
      bang.className = 'urgent-dot';
      bang.textContent = '!';
      headRow.appendChild(bang);
    }
    btn.appendChild(headRow);
    if (list.length > 0) {
      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';
      if (list.some((b) => b.time === 'morning')) {
        const t = document.createElement('span'); t.className = 'tag morning'; t.textContent = 'AM'; tagRow.appendChild(t);
      }
      if (list.some((b) => b.time === 'afternoon')) {
        const t = document.createElement('span'); t.className = 'tag afternoon'; t.textContent = 'PM'; tagRow.appendChild(t);
      }
      btn.appendChild(tagRow);
    }
    btn.addEventListener('click', () => openAdminDayDetail(dstr));
    root.appendChild(btn);
  }
  if (state.admin.selectedDate) openAdminDayDetail(state.admin.selectedDate, { keepOpen: true });
}

function openAdminDayDetail(dstr, opts = {}) {
  state.admin.selectedDate = dstr;
  const blocks = state.admin.allBlocks
    .filter((b) => b.date === dstr && adminMatchesFilters(b))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const host = $('admin-day-detail');
  host.classList.remove('hidden');
  const title = new Date(dstr + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  $('admin-day-detail-title').textContent = 'Blocks on ' + title;
  const list = $('admin-day-detail-list');
  list.innerHTML = '';
  if (blocks.length === 0) {
    list.innerHTML = '<div class="empty-state">No matching blocks.</div>';
    return;
  }
  for (const b of blocks) {
    const card = document.createElement('div');
    const isSched = b.source === 'schedule';
    card.className = 'block-card' + (b.urgent ? ' urgent' : '') + (isSched ? ' schedule-only' : '');
    const sourceBadge = isSched
      ? ' <span class="source-badge schedule">scheduled</span>'
      : ' <span class="source-badge posted">posted</span>';
    card.innerHTML =
      '<div class="meta">' +
        '<div class="title">' + escapeHtml(b.type || '') + ' — ' + escapeHtml(b.time === 'morning' ? 'Morning' : 'Afternoon') +
          sourceBadge +
          (b.urgent ? ' <span class="urgent-badge">urgent</span>' : '') +
        '</div>' +
        '<div class="sub">' + escapeHtml(b.date) + ' • ' + escapeHtml(b.name || '—') + ' (' + escapeHtml(b.sNumber || '') + ')</div>' +
      '</div>' +
      '<div class="contact">' + (b.phone ? escapeHtml(b.phone) : '<span class="muted">no phone</span>') + '</div>' +
      (b.notes ? '<div class="notes">' + escapeHtml(b.notes) + '</div>' : '');
    list.appendChild(card);
  }
}

function closeAdminDayDetail() {
  state.admin.selectedDate = null;
  $('admin-day-detail').classList.add('hidden');
}

/* ----------------------------- wiring ----------------------------- */

function wireEvents() {
  $('signin-form').addEventListener('submit', handleSignInSubmit);
  $('pin-form').addEventListener('submit', handlePinSubmit);
  $('pin-back').addEventListener('click', handlePinBack);
  $('setup-form').addEventListener('submit', handleSetupSubmit);
  $('setup-back').addEventListener('click', handleSetupBack);

  $('profile-edit-form').addEventListener('submit', handleProfileEditSubmit);
  $('profile-signout').addEventListener('click', handleSignOut);

  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  const signinBtn = $('nav-signin-btn');
  if (signinBtn) signinBtn.addEventListener('click', () => showSignIn());

  $('filter-type').addEventListener('change', (e) => {
    state.filterType = e.target.value;
    renderCalendar();
  });
  $('filter-time').addEventListener('change', (e) => {
    state.filterTime = e.target.value;
    renderCalendar();
  });

  $('cal-prev').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    closeDayDetail();
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    closeDayDetail();
    renderCalendar();
  });

  $('day-detail-close').addEventListener('click', closeDayDetail);

  $('post-form').addEventListener('submit', handlePostBlock);

  $('import-file').addEventListener('change', handleScreenshotUpload);

  const dropZone = $('drop-zone');
  dropZone.addEventListener('click', () => $('import-file').click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    processScreenshotFiles(files);
  });
  $('schedule-clear').addEventListener('click', handleScheduleClear);
  $('reminder-enabled').addEventListener('change', handleReminderToggle);
  $('download-ics').addEventListener('click', handleDownloadIcs);

  $('my-blocks-edit-btn').addEventListener('click', () => setMyBlocksMode('edit'));
  $('my-blocks-done-btn').addEventListener('click', () => setMyBlocksMode('display'));

  $('costs-filter').addEventListener('input', renderProcedureCosts);
  $('costs-show-unknown').addEventListener('change', renderProcedureCosts);

  /* ------- assist view wiring ------- */
  document.querySelectorAll('#view-assist .assist-tab').forEach((b) => {
    b.addEventListener('click', () => setAssistTab(b.dataset.assistTab));
  });
  $('assist-form').addEventListener('submit', handleAssistPostSubmit);
  $('assist-date').addEventListener('change', populateAssistTimeSelect);
  $('assist-filter-procedure').addEventListener('change', (e) => {
    state.assistFilterProcedure = e.target.value;
    if (state.view === 'assist' && state.assistTab === 'board') renderAssistBoard();
  });

  /* ------- admin view wiring ------- */
  document.querySelectorAll('#view-admin .admin-tab').forEach((b) => {
    b.addEventListener('click', () => setAdminSubView(b.dataset.adminTab));
  });
  const refreshBtn = $('admin-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    await loadAdminData();
    setAdminSubView(state.admin.subView || 'users');
  });
  const forgetBtn = $('admin-forget');
  if (forgetBtn) forgetBtn.addEventListener('click', () => {
    if (confirm('Remove admin access from this browser?')) forgetAdmin();
  });
  const acPrev = $('admin-cal-prev');
  const acNext = $('admin-cal-next');
  if (acPrev) acPrev.addEventListener('click', () => {
    state.admin.calMonth = new Date(state.admin.calMonth.getFullYear(), state.admin.calMonth.getMonth() - 1, 1);
    closeAdminDayDetail();
    renderAdminCalendar();
  });
  if (acNext) acNext.addEventListener('click', () => {
    state.admin.calMonth = new Date(state.admin.calMonth.getFullYear(), state.admin.calMonth.getMonth() + 1, 1);
    closeAdminDayDetail();
    renderAdminCalendar();
  });
  const adFilterType = $('admin-cal-filter-type');
  const adFilterTime = $('admin-cal-filter-time');
  const adFilterUser = $('admin-cal-filter-user');
  if (adFilterType) adFilterType.addEventListener('change', (e) => { state.admin.filterType = e.target.value; renderAdminCalendar(); });
  if (adFilterTime) adFilterTime.addEventListener('change', (e) => { state.admin.filterTime = e.target.value; renderAdminCalendar(); });
  if (adFilterUser) adFilterUser.addEventListener('change', (e) => { state.admin.filterUser = e.target.value; renderAdminCalendar(); });
  const adClose = $('admin-day-detail-close');
  if (adClose) adClose.addEventListener('click', closeAdminDayDetail);

  /* ------- session lifecycle ------- */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.sessionId) heartbeat();
  });
  window.addEventListener('pagehide', () => { heartbeat(); });
}

/* ----------------------------- boot ----------------------------- */

async function boot() {
  $('year').textContent = new Date().getFullYear();
  state.calMonth = new Date();
  state.calMonth.setDate(1);

  const adminBanner = $('admin-banner');
  if (adminBanner) attachHolo(adminBanner);

  populateBlockTypeSelects();
  wireEvents();
  loadLocalProfile();
  initFirestore();
  // Sign in anonymously BEFORE touching any data so rules that require
  // request.auth != null are satisfied on the first read. If this
  // fails, every subsequent Firestore op would fail with permission-
  // denied, so we bail out to the sign-in screen rather than show a
  // broken app.
  const authUser = state.firestoreReady ? await ensureAnonAuth() : null;
  if (state.firestoreReady && !authUser) {
    handleAuthLoss('Sign-in unavailable — please try again in a moment.');
    return;
  }

  // Keep an eye on auth state so a mid-session auth loss (token
  // revoked, clock skew, etc.) also bounces the user to sign-in
  // instead of leaving them in a "signed in but broken" state.
  if (typeof firebase !== 'undefined' && firebase.auth) {
    firebase.auth().onAuthStateChanged((u) => {
      if (!u) handleAuthLoss('Session expired — please sign in again.');
    });
  }

  subscribeBlocks();
  await maybeBootstrapAdmin();

  if (profileValid(state.profile) && state.firestoreReady) {
    showApp();
    try {
      const fresh = await fetchUserDoc(state.profile.sNumber);
      if (fresh && validName(fresh.name) && validPhoneOrEmpty(fresh.phone)) {
        cacheProfile({ name: fresh.name, sNumber: state.profile.sNumber, phone: fresh.phone });
        if (state.view === 'profile') fillProfileEditForm();
      }
    } catch (e) { /* ignore */ }
  } else {
    showSignIn();
  }
}

document.addEventListener('DOMContentLoaded', boot);
