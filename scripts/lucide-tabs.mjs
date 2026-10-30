import { ArrowUpRight, BadgeCheck, Bot, Check, ChevronRight, CircleAlert, CircleCheckBig, CircleHelp, CirclePause, CircleX, Clock3, Copy, createIcons, Eye, FileQuestion, Files, Folder, GitBranch, GitCompareArrows, House, Info, Lightbulb, ListChecks, ListFilter, ListTodo, MessageSquare, MessageSquareText, MessagesSquare, RefreshCw, Send, TriangleAlert, UserRound, Users, X } from 'lucide';

const icons = { ArrowUpRight, BadgeCheck, Bot, Check, ChevronRight, CircleAlert, CircleCheckBig, CircleHelp, CirclePause, CircleX, Clock3, Copy, Eye, FileQuestion, Files, Folder, GitBranch, GitCompareArrows, House, Info, Lightbulb, ListChecks, ListFilter, ListTodo, MessageSquare, MessageSquareText, MessagesSquare, RefreshCw, Send, TriangleAlert, UserRound, Users, X };
const render = root => createIcons({ icons, root });
window.fluxIcons = { render };
render(document);
document.documentElement.classList.add('lucide-ready');
