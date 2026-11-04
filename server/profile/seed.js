// Initial knowledge base, transcribed from the uploaded CV
// (CV_Fatima-Christine_Mariko.docx) and the profile given in the brief.
// "confirmed" = stated in the CV or the brief.
// "transferable" = reasonable inferences; they are NOT used in documents until
// the user confirms them on the Profile page.
// "questions" = information still missing; the agent asks instead of inventing.

export const seedProfile = {
  identity: {
    full_name: 'Fatima-Christine MARIKO',
    first_name: 'Fatima-Christine',
    last_name: 'MARIKO',
    phone: '06 30 73 26 40',
    email: 'fc45.mariko@gmail.com',
    city: 'Orléans',
    headline: 'Étudiante en Licence 3 LEA – Commerce international',
  },
  internship: {
    duration: '6 semaines',
    period: 'à débuter entre mi-avril et juin 2027',
    target_areas: [
      'Commerce international', 'Import / export', 'Développement commercial international',
      'Administration des ventes export', 'Logistique internationale / supply chain', 'Achats',
      'Coordination / opérations commerciales', 'Études de marché', 'Prospection internationale',
      'Relation client internationale',
    ],
    locations: ['Orléans et alentours', 'Paris et Île-de-France'],
    cv_profile_text: "Étudiante en troisième année de LEA (anglais, espagnol), parcours Commerce international, à l'Université d'Orléans. Je recherche un stage de 6 semaines à débuter entre mi-avril et juin 2027, en logistique / supply chain, commerce international, import-export, achats ou opérations commerciales, afin de mettre en pratique ma formation et de découvrir le fonctionnement d'une entreprise.",
  },
  languages: [
    { id: 'fr', name: 'Français', level: 'Langue maternelle' },
    { id: 'en', name: 'Anglais', level: 'Niveau C2' },
    { id: 'es', name: 'Espagnol', level: 'Niveau B2' },
  ],
  education: [
    {
      id: 'l3', title: 'Licence 3 Langues étrangères appliquées – Commerce international', institution: "Université d'Orléans", dates: '2026–2027',
      courses: ['anglais économique et commercial', 'traduction anglaise', 'thème espagnol', 'comptabilité générale', 'commerce et économie internationale'],
    },
    { id: 'bac', title: 'Baccalauréat général', institution: 'Lycée Charles Péguy', dates: '2022', courses: [] },
  ],
  experiences: [
    {
      id: 'croix-rouge', title: 'Volontaire en Service Civique', organization: 'Croix-Rouge française – Saint-Jean-le-Blanc', dates: 'Sept. 2026 – avril 2027',
      summary: "Mission d'accompagnement de personnes en situation de précarité vers l'autonomie et l'inclusion sociale, notamment de mineurs non accompagnés de 16 à 18 ans.",
      bullets: [
        'Accueil et écoute des jeunes.',
        'Participation à des animations collectives et socioculturelles.',
        'Aide à la rédaction de CV et de lettres de motivation.',
        'Accompagnement de jeunes souhaitant découvrir les activités de la Croix-Rouge.',
        "Participation aux activités de l'association, avec les salariés et les autres volontaires.",
      ],
    },
    {
      id: 'deret', title: 'Préparatrice de commandes', organization: 'Deret – logistique e-commerce', dates: 'Été 2022',
      summary: '', bullets: ['Préparation de commandes en entrepôt.', 'Travail en équipe dans un environnement logistique.'],
    },
    { id: 'garde', title: "Garde d'enfants", organization: 'Particuliers', dates: '2023', summary: '', bullets: ["Garde d'enfants âgés de 3 à 10 ans."] },
    { id: 'bathart', title: 'Distribution de flyers', organization: 'Association de théâtre Bathart', dates: '', summary: '', bullets: ["Contribution à la communication d'une association de théâtre."] },
    { id: 'couronnerie', title: 'Stage d’observation (3e) – Logistique et distribution', organization: 'La Couronnerie', dates: '2019', summary: '', bullets: ["Découverte des activités d'entreposage et d'expédition."] },
  ],
  skills: [
    { id: 'lang', label: 'Langues et rédaction', value: "communication écrite et orale en français, anglais et espagnol ; traduction et rédaction ; recherche d'informations" },
    { id: 'notions', label: 'Notions acquises en formation', value: 'commerce international, comptabilité générale ; connaissances de base en logistique' },
    { id: 'soft', label: 'Savoir-être', value: 'travail en équipe, organisation, adaptation' },
    { id: 'tools', label: 'Outils numériques', value: 'Word (très bon niveau) · Excel (bases) · PowerPoint (bases)' },
  ],
  interests: 'Théâtre (participation à plusieurs pièces en association) · cinéma · apprentissage des langues · création de contenus numériques',

  transferable: [
    { id: 't1', text: "Habitude d'échanger avec des publics variés, y compris des jeunes non francophones ou peu francophones", basis: 'Service Civique à la Croix-Rouge (accueil et écoute de mineurs non accompagnés)', status: 'suggested' },
    { id: 't2', text: 'Première connaissance concrète du fonctionnement d’un entrepôt (préparation de commandes, expédition)', basis: 'Préparatrice de commandes chez Deret (2022) et stage d’observation à La Couronnerie (2019)', status: 'suggested' },
    { id: 't3', text: 'Aisance pour rédiger des documents simples et structurés (CV, lettres)', basis: 'Aide à la rédaction de CV et de lettres de motivation (Croix-Rouge) ; enseignements de traduction', status: 'suggested' },
    { id: 't4', text: 'Capacité à rechercher et synthétiser des informations en anglais et en espagnol', basis: "Compétence « recherche d'informations » et formation LEA", status: 'suggested' },
  ],

  questions: [
    { id: 'q-handbook', question: "Le guide des stages de l'Université d'Orléans n'a pas encore été importé. Merci de le téléverser (page Profil) pour que les exigences (durée, dates, convention, missions acceptées) soient vérifiées.", answer: '', status: 'open' },
    { id: 'q-level', question: "Comment souhaitez-vous présenter votre niveau d'études : « Bac+3 (en cours) » ou autrement ?", answer: '', status: 'open' },
    { id: 'q-dates', question: 'Avez-vous des dates de stage plus précises (date de début au plus tôt, date de fin au plus tard) ?', answer: '', status: 'open' },
    { id: 'q-mobility', question: 'Pour Paris : pouvez-vous vous loger sur place ou faire les trajets depuis Orléans pendant 6 semaines ?', answer: '', status: 'open' },
    { id: 'q-certif', question: "Votre niveau C2 en anglais et B2 en espagnol correspond-il à une certification (ex. TOEIC, Cambridge, DELE) ou à une auto-évaluation / évaluation universitaire ? (Les documents n'en mentionneront aucune sans confirmation.)", answer: '', status: 'open' },
    { id: 'q-other-langs', question: 'Pratiquez-vous une autre langue, même à un niveau élémentaire ? (Laisser vide si non.)', answer: '', status: 'open' },
    { id: 'q-linkedin', question: 'Souhaitez-vous indiquer un profil LinkedIn sur le CV ? Si oui, lequel ?', answer: '', status: 'open' },
  ],
};
