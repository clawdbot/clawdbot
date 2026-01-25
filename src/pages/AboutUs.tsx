import React from 'react';
import { Heart, Code, Shield, Users, Github, Mail, ExternalLink, ChevronRight } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
// import { Layout } from '../components/Layout';
// import { DonationButton } from '../components/DonationButton';

// import team images
import prathamimg from '../../public/image/pratham_kumar.png';
import pallaviimg from '../../public/image/pallavi_kumari.png';
import monikaimg from '../../public/image/monika_agrawal.png';
import Aryaimg from '../../public/image/arya.png';

const AboutUs = () => {
    return (
        <div className="font-sans">
            <Helmet>
                <title>About Us - SecureChat | Open Source Encrypted Messaging</title>
                <meta name="description" content="Learn about SecureChat's mission to provide free, secure, and private communication. Open-source encrypted messaging built with React, Node.js, and WebSocket." />
                <meta name="keywords" content="about securechat, open source encrypted chat, free secure messaging, privacy-focused chat, secure chat developer, encrypted messaging project" />
                <link rel="canonical" href="https://securechat.vercel.app/about" />
            </Helmet>
            <div className="min-h-screen text-white py-20 px-4 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-gray-900 via-[#0a0a0a] to-black">
                {/* Header */}
                <div className="max-w-7xl mx-auto text-center mb-24 animate-fade-in relative z-10">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl -z-10 animate-pulse"></div>
                    <div className="inline-block mb-8 relative">
                        <div className="absolute inset-0 bg-red-500/20 blur-xl rounded-full animate-pulse"></div>
                        <Heart className="w-24 h-24 text-red-500 mx-auto relative z-10 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]" />
                    </div>
                    <h1 className="text-6xl md:text-7xl font-bold mb-8 tracking-tight">
                        <span className="bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent animate-gradient bg-[length:200%_auto]">
                            About SecureChat
                        </span>
                    </h1>
                    <p className="text-2xl text-gray-400 max-w-3xl mx-auto leading-relaxed font-light">
                        Redefining privacy with open-source encrypted messaging that's simple, secure, and free.
                    </p>
                </div>

                {/* Mission Section */}
                <div className="max-w-7xl mx-auto mb-24">
                    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl p-8 md:p-12 shadow-2xl">
                        <div className="absolute top-0 right-0 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
                        <h2 className="text-4xl md:text-5xl font-bold mb-12 text-center text-white">
                            Why We Built This
                        </h2>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 relative z-10">
                            <div className="group p-8 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-300 hover:-translate-y-2">
                                <div className="w-16 h-16 bg-blue-500/20 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                    <Shield className="w-8 h-8 text-blue-400" />
                                </div>
                                <h3 className="text-2xl font-bold mb-4 text-white">Zero Data Collection</h3>
                                <p className="text-gray-400 leading-relaxed">
                                    We believe privacy is a fundamental right. We don't ask for your phone number, email, or any personal details. Just chat.
                                </p>
                            </div>

                            <div className="group p-8 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-300 hover:-translate-y-2">
                                <div className="w-16 h-16 bg-green-500/20 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                    <Code className="w-8 h-8 text-green-400" />
                                </div>
                                <h3 className="text-2xl font-bold mb-4 text-white">Fully Transparent</h3>
                                <p className="text-gray-400 leading-relaxed">
                                    Trust through transparency. Our entire codebase is open-source and available on GitHub for anyone to audit and verify.
                                </p>
                            </div>

                            <div className="group p-8 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-300 hover:-translate-y-2">
                                <div className="w-16 h-16 bg-purple-500/20 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                    <Users className="w-8 h-8 text-purple-400" />
                                </div>
                                <h3 className="text-2xl font-bold mb-4 text-white">Actually Free</h3>
                                <p className="text-gray-400 leading-relaxed">
                                    Software should empower people, not exploit them. No premium tiers, no ads, no hidden costs. Just free, secure communication.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Story Section */}
                <div className="max-w-5xl mx-auto mb-24">
                    <div className="relative">
                        <div className="absolute -left-4 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 via-purple-500 to-transparent opacity-50 hidden md:block"></div>
                        <div className="md:pl-12">
                            <h2 className="text-4xl font-bold mb-8 flex items-center gap-4">
                                <span className="text-blue-400">#</span> How It Started
                            </h2>
                            <div className="prose prose-lg prose-invert max-w-none text-gray-300">
                                <p className="text-xl leading-relaxed mb-6">
                                    SecureChat wasn't built by a corporation. It began as a passionate effective to demystify end-to-end encryption.
                                    After diving deep into cryptography papers and the Signal protocol, the mission became clear: <span className="text-white font-semibold">build a practical, accessible, and secure messaging tool.</span>
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 my-8">
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10">
                                        <h4 className="font-bold text-white mb-2 flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-green-400"></div>
                                            Client-Side Encryption
                                        </h4>
                                        <p className="text-sm">Messages are locked on your device before they ever touch the network.</p>
                                    </div>
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10">
                                        <h4 className="font-bold text-white mb-2 flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-red-400"></div>
                                            Zero Server Knowledge
                                        </h4>
                                        <p className="text-sm">The server is just a courier. It cannot read or understand your messages.</p>
                                    </div>
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10">
                                        <h4 className="font-bold text-white mb-2 flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-yellow-400"></div>
                                            Ephemeral by Design
                                        </h4>
                                        <p className="text-sm">No databases. No history. Everything vanishes when the session ends.</p>
                                    </div>
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10">
                                        <h4 className="font-bold text-white mb-2 flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-blue-400"></div>
                                            Educational Core
                                        </h4>
                                        <p className="text-sm">Code written to be understood, learnt from, and improved by the community.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Technology Stack */}
                <div className="max-w-7xl mx-auto mb-24">
                    <h2 className="text-4xl font-bold mb-12 text-center">Built With Modern Tech</h2>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                        {[
                            { name: "React 18", color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
                            { name: "TypeScript", color: "text-blue-500", bg: "bg-blue-600/10", border: "border-blue-600/20" },
                            { name: "Node.js", color: "text-green-500", bg: "bg-green-500/10", border: "border-green-500/20" },
                            { name: "Socket.IO", color: "text-gray-200", bg: "bg-gray-500/10", border: "border-gray-500/20" },
                            { name: "Tailwind", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/20" },
                            { name: "Web Crypto", color: "text-pink-500", bg: "bg-pink-500/10", border: "border-pink-500/20" },
                            { name: "Vite", color: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/20" },
                            { name: "Express", color: "text-white", bg: "bg-white/5", border: "border-white/10" }
                        ].map((tech, idx) => (
                            <div
                                key={idx}
                                className={`group ${tech.bg} backdrop-blur-sm rounded-xl p-6 border ${tech.border} text-center hover:scale-105 transition-all duration-300 cursor-default`}
                            >
                                <div className={`text-xl font-bold ${tech.color} group-hover:scale-110 transition-transform duration-300`}>
                                    {tech.name}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Developer Section */}
                <div className="max-w-4xl mx-auto mb-16">
                    <h2 className="text-4xl font-bold mb-8 text-center">About the Developer</h2>
                    <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20">
                        <div className="flex flex-col md:flex-row items-center gap-8">
                            <div className="flex-shrink-0">
                                {/* Replaced AR text with image */}
                                <div className="w-32 h-32 rounded-full overflow-hidden border-2 border-white/20">
                                    <img
                                        src={Aryaimg}
                                        alt="Arya"
                                        className="w-full h-full object-cover"
                                    />
                                </div>
                            </div>
                            <div className="flex-1 text-center md:text-left">
                                <h3 className="text-2xl font-bold mb-2">Arya</h3>
                                <p className="text-gray-400 mb-4">
                                    Full-Stack Developer & Security Enthusiast
                                </p>
                                <p className="text-gray-300 mb-6">
                                    I'm currently a BTech student specializing in Cybersecurity and IoT Security.
                                    This project started as a way to deeply understand how encryption actually works
                                    in real applications, beyond just theory. I built it to learn, and I'm sharing it
                                    so others can learn too.
                                </p>
                                <div className="flex gap-4 justify-center md:justify-start">
                                    <a
                                        href="https://github.com/Arya182-ui"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg transition-colors"
                                    >
                                        <Github className="w-5 h-5" />
                                        <span>GitHub</span>
                                    </a>
                                    <a
                                        href="mailto:arya119000@gmail.com"
                                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors"
                                    >
                                        <Mail className="w-5 h-5" />
                                        <span>Contact</span>
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Team Section */}
                <div className="max-w-6xl mx-auto mb-16">
                    <h2 className="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                        Meet Our Team
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                        {/* Pratham Kumar */}
                        <div className="group bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20 hover:border-white/30 transition-all duration-300 transform hover:scale-105 shadow-lg hover:shadow-2xl text-center">
                            <div className="mb-6">
                                <div className="w-32 h-32 rounded-full overflow-hidden border-3 border-blue-400/30 mx-auto mb-4 group-hover:border-blue-400/50 transition-colors">
                                    <img
                                        src={prathamimg}
                                        alt="Pratham Kumar"
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.style.display = 'none';
                                            target.nextElementSibling?.classList.remove('hidden');
                                        }}
                                    />
                                    <div className="hidden w-full h-full bg-gradient-to-br from-blue-500 to-purple-500 items-center justify-center text-2xl font-bold text-white">
                                        PK
                                    </div>
                                </div>
                            </div>
                            <h3 className="text-2xl font-bold mb-2 text-white">Pratham Kumar</h3>
                            <p className="text-blue-400 font-medium mb-4">Core Developer & Creator of PrivyChat</p>
                            <p className="text-gray-300 text-sm mb-4">
                                Passionate developer contributing to secure communication solutions.
                            </p>
                            <a
                                href="https://github.com/rajpratham1"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
                            >
                                <Github className="w-5 h-5" />
                                <span>@rajpratham1</span>
                            </a>
                        </div>

                        {/* Pallavi Kumari */}
                        <div className="group bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20 hover:border-white/30 transition-all duration-300 transform hover:scale-105 shadow-lg hover:shadow-2xl text-center">
                            <div className="mb-6">
                                <div className="w-32 h-32 rounded-full overflow-hidden border-3 border-pink-400/30 mx-auto mb-4 group-hover:border-pink-400/50 transition-colors">
                                    <img
                                        src={pallaviimg}
                                        alt="Pallavi Kumari"
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.style.display = 'none';
                                            target.nextElementSibling?.classList.remove('hidden');
                                        }}
                                    />
                                    <div className="hidden w-full h-full bg-gradient-to-br from-pink-500 to-purple-500 items-center justify-center text-2xl font-bold text-white">
                                        PK
                                    </div>
                                </div>
                            </div>
                            <h3 className="text-2xl font-bold mb-2 text-white">Pallavi Kumari</h3>
                            <p className="text-pink-400 font-medium mb-4">Team Member</p>
                            <p className="text-gray-300 text-sm">
                                Dedicated team member focused on user experience and design
                            </p>
                        </div>

                        {/* Monika Agrawal */}
                        <div className="group bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20 hover:border-white/30 transition-all duration-300 transform hover:scale-105 shadow-lg hover:shadow-2xl text-center">
                            <div className="mb-6">
                                <div className="w-32 h-32 rounded-full overflow-hidden border-3 border-green-400/30 mx-auto mb-4 group-hover:border-green-400/50 transition-colors">
                                    <img
                                        src={monikaimg}
                                        alt="Monika Agrawal"
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.style.display = 'none';
                                            target.nextElementSibling?.classList.remove('hidden');
                                        }}
                                    />
                                    <div className="hidden w-full h-full bg-gradient-to-br from-green-500 to-teal-500 items-center justify-center text-2xl font-bold text-white">
                                        MA
                                    </div>
                                </div>
                            </div>
                            <h3 className="text-2xl font-bold mb-2 text-white">Monika Agrawal</h3>
                            <p className="text-green-400 font-medium mb-4">Team Member</p>
                            <p className="text-gray-300 text-sm">
                                Innovative developer working on security and encryption features
                            </p>
                        </div>
                    </div>

                    {/* Team Description */}
                    <div className="mt-12 text-center">
                        <p className="text-lg text-gray-300 max-w-3xl mx-auto">
                            Our diverse team brings together different perspectives and skills to create
                            a secure, user-friendly messaging platform. Together, we're committed to
                            building privacy-focused communication tools for everyone.
                        </p>
                    </div>
                </div>



                {/* Integrated Ecosystem: PrivyChat */}
                <div className="max-w-6xl mx-auto mb-24">
                    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl p-8 md:p-12 shadow-2xl">
                        <div className="absolute top-0 right-0 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>

                        <div className="relative z-10">
                            <h2 className="text-4xl font-bold mb-8 text-center">
                                Integrated Ecosystem: <span className="text-purple-400">PrivyChat</span>
                            </h2>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
                                <div>
                                    <div className="inline-block px-3 py-1 mb-4 rounded-full bg-purple-500/20 text-purple-300 text-sm font-medium border border-purple-500/30">
                                        Zero-Trace Spy Messenger
                                    </div>
                                    <p className="text-lg text-gray-300 mb-6 leading-relaxed">
                                        We have seamlessly integrated <strong>PrivyChat</strong> to provide secure <strong>Video and Voice Calling</strong> capabilities.
                                        PrivyChat is an open-source, ultra-secure messaging platform built with a "Zero-Trust" philosophy by <a href="https://github.com/rajpratham1" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-semibold transition-colors">Pratham Kumar</a>.
                                    </p>

                                    <ul className="space-y-4 mb-8">
                                        {[
                                            "🎥 RAM-Only Architecture (Zero Data Retention)",
                                            "📞 HD Video & Voice Calls (WebRTC)",
                                            "🎭 Stealth Mode & Decoy Calculator",
                                            "🔒 Military-Grade Encryption (AES-GCM + RSA)"
                                        ].map((feature, idx) => (
                                            <li key={idx} className="flex items-center gap-3 text-gray-300">
                                                <div className="w-1.5 h-1.5 rounded-full bg-purple-400"></div>
                                                {feature}
                                            </li>
                                        ))}
                                    </ul>

                                    <div className="space-y-4">
                                        <h4 className="text-white font-semibold flex items-center gap-2">
                                            <Code className="w-4 h-4 text-gray-400" />
                                            How to Use
                                        </h4>
                                        <p className="text-gray-400 text-sm mb-6">
                                            Click the <strong>"Video Call"</strong> button in the top navigation bar to access PrivyChat directly.
                                        </p>

                                        <div className="flex flex-col sm:flex-row gap-4">
                                            <a
                                                href="https://privy-chat.onrender.com/"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white px-6 py-3 rounded-xl font-semibold transition-all shadow-lg hover:shadow-purple-500/25"
                                            >
                                                <ExternalLink className="w-5 h-5" />
                                                Launch PrivyChat
                                            </a>
                                            <a
                                                href="https://github.com/rajpratham1"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-white px-6 py-3 rounded-xl font-semibold border border-white/10 transition-all"
                                            >
                                                <Github className="w-5 h-5" />
                                                Developer Profile
                                            </a>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-6">
                                    {/* Creator Profile Card */}
                                    <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 text-center transform transition-all hover:scale-105 duration-300">
                                        <div className="w-24 h-24 rounded-full overflow-hidden border-2 border-purple-400 mx-auto mb-4">
                                            <img
                                                src={prathamimg}
                                                alt="Pratham Kumar"
                                                className="w-full h-full object-cover"
                                                onError={(e) => {
                                                    const target = e.target as HTMLImageElement;
                                                    target.style.display = 'none';
                                                    target.nextElementSibling?.classList.remove('hidden');
                                                }}
                                            />
                                            <div className="hidden w-full h-full bg-gradient-to-br from-purple-500 to-indigo-500 items-center justify-center text-xl font-bold text-white">
                                                PK
                                            </div>
                                        </div>
                                        <h3 className="text-xl font-bold text-white mb-1">Pratham Kumar</h3>
                                        <p className="text-blue-400 text-sm font-medium mb-3">Core Developer & Creator of PrivyChat</p>
                                        <p className="text-gray-300 text-xs mb-4">
                                            Passionate developer contributing to secure communication solutions.
                                        </p>
                                        <a
                                            href="https://github.com/rajpratham1"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
                                        >
                                            <Github className="w-4 h-4" />
                                            <span>@rajpratham1</span>
                                        </a>
                                    </div>


                                    <div className="bg-black/40 rounded-xl p-6 border border-white/10 backdrop-blur-md">
                                        <h4 className="text-purple-400 font-bold mb-2">Philosophy</h4>
                                        <p className="text-gray-400 italic">
                                            "Privacy is not a crime. It is a fundamental human right."
                                        </p>
                                    </div>
                                    <div className="bg-black/40 rounded-xl p-6 border border-white/10 backdrop-blur-md">
                                        <h4 className="text-red-400 font-bold mb-2">Zero-Trust</h4>
                                        <p className="text-gray-400 text-sm">
                                            We assume the server is compromised, the network is tapped, and the device might be seized.
                                            That's why PrivyChat operates entirely in RAM.
                                        </p>
                                    </div>
                                    <div className="bg-black/40 rounded-xl p-6 border border-white/10 backdrop-blur-md">
                                        <h4 className="text-blue-400 font-bold mb-2">Features</h4>
                                        <div className="flex flex-wrap gap-2">
                                            {['Video Call', 'Audio Call', 'File Sharing', 'Message Limit', 'Mask Features'].map((tag) => (
                                                <span key={tag} className="px-2 py-1 rounded-md bg-white/5 text-xs text-gray-300 border border-white/10">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Testimonials Section */}
                <div className="max-w-7xl mx-auto mb-24 px-4">
                    <div className="flex items-center gap-4 mb-12">
                        <div className="h-px bg-red-500/50 flex-1"></div>
                        <h2 className="text-3xl font-bold text-center text-white flex items-center gap-2">
                            <span className="text-red-500">⟩</span> What People Say
                        </h2>
                        <a href="#" className="text-red-500 text-sm hover:text-red-400 transition-colors flex items-center gap-1">
                            View all <ChevronRight className="w-4 h-4" />
                        </a>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        {[
                            {
                                name: "AryehDubois",
                                handle: "@AryehDubois",
                                text: "Tried Clawd by @steipete. I tried to build my own AI assistant bots before, and I am very impressed how many hard things Clawd gets...",
                                image: "https://avatars.githubusercontent.com/u/5909950?v=4"
                            },
                            {
                                name: "markjaquith",
                                handle: "@markjaquith",
                                text: "I've been saying for like six months that LLMs suddenly stopped improving, we spend \"years\" discovering new transfor...",
                                image: "https://avatars.githubusercontent.com/u/31819391?v=4"
                            },
                            {
                                name: "Senator_NFTs",
                                handle: "@Senator_NFTs",
                                text: "clawdbot is a game changer. the potential for custom extensions is huge, and ai really speeds up the process",
                                image: "https://avatars.githubusercontent.com/u/255777700?v=4"
                            },
                            {
                                name: "mneves75",
                                handle: "@mneves75",
                                text: "Try @clawdbot. I think you are going to love it. And you can use iMessage, WhatsApp, to talk to it.",
                                image: "https://avatars.githubusercontent.com/u/2423436?v=4"
                            }
                        ].map((testimonial, idx) => (
                            <div key={idx} className="bg-[#0f1219] p-6 rounded-2xl border border-white/5 hover:border-red-500/30 transition-all group">
                                <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                                    "{testimonial.text}"
                                </p>
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-white/10 overflow-hidden border border-white/10 group-hover:border-red-500/50 transition-colors">
                                        <img src={testimonial.image} alt={testimonial.name} className="w-full h-full object-cover" />
                                    </div>
                                    <div>
                                        <div className="text-white text-sm font-semibold">{testimonial.name}</div>
                                        <div className="text-red-500 text-xs">{testimonial.handle}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Open Source & Support Section - Combined */}
                <div className="max-w-6xl mx-auto mb-16">
                    <h2 className="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                        Open Source & Support
                    </h2>

                    {/* Single Combined Box */}
                    <div className="relative group bg-gradient-to-br from-blue-600/20 via-purple-600/20 to-yellow-600/20 backdrop-blur-lg rounded-2xl p-12 border border-white/20 overflow-hidden shadow-2xl">
                        {/* Animated background */}
                        <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 opacity-0 group-hover:opacity-10 transition-opacity duration-500"></div>

                        <div className="relative z-10">
                            {/* GitHub Section */}
                            <div className="text-center mb-12 pb-12 border-b border-white/20">
                                <Github className="w-16 h-16 text-blue-400 mx-auto mb-4" />
                                <h3 className="text-2xl font-bold mb-4 text-white">Contribute on GitHub</h3>
                                <p className="text-lg mb-6 text-gray-300 max-w-2xl mx-auto">
                                    This project is completely open source. Explore the code, suggest improvements,
                                    or report bugs. Every contribution helps make this project better.
                                </p>
                                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                                    <a
                                        href="https://github.com/Arya182-ui/End2end-Chat"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="group/btn inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-lg font-semibold hover:bg-blue-700 transition-all duration-300 transform hover:scale-105 shadow-lg"
                                    >
                                        <Github className="w-5 h-5" />
                                        View on GitHub
                                        <ExternalLink className="w-4 h-4 group-hover/btn:translate-x-1 group-hover/btn:-translate-y-1 transition-transform duration-300" />
                                    </a>
                                    <a
                                        href="https://github.com/Arya182-ui/End2end-Chat/issues"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="group/btn inline-flex items-center justify-center gap-2 bg-white/10 backdrop-blur text-white px-8 py-4 rounded-lg font-semibold hover:bg-white/20 transition-all duration-300 border border-white/30 transform hover:scale-105 shadow-lg"
                                    >
                                        Report an Issue
                                        <ExternalLink className="w-4 h-4 group-hover/btn:translate-x-1 group-hover/btn:-translate-y-1 transition-transform duration-300" />
                                    </a>
                                </div>
                            </div>

                            {/* Donation Section */}
                            <div className="text-center">
                                <Heart className="w-16 h-16 text-red-400 mx-auto mb-4 animate-pulse" />
                                <h3 className="text-2xl font-bold mb-4 bg-gradient-to-r from-yellow-400 to-orange-400 bg-clip-text text-transparent">
                                    Support This Project
                                </h3>
                                <p className="text-lg text-gray-300 mb-6 max-w-2xl mx-auto">
                                    SecureChat is completely free and open-source. If you find it useful,
                                    consider supporting its development to keep it running and improving.
                                </p>
                                <div className="flex justify-center">
                                    {/* <DonationButton /> */}
                                    <button className="bg-red-500 text-white px-6 py-2 rounded-lg font-bold">Donate</button>
                                </div>
                                <p className="text-sm text-gray-400 mt-6">
                                    Every contribution helps maintain servers and add new features! 🚀
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer CTA */}
                <div className="max-w-4xl mx-auto text-center">
                    <h2 className="text-3xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                        Try It Out
                    </h2>
                    <p className="text-gray-300 mb-8 text-lg">
                        No signup required. Just pick a name and start chatting securely.
                    </p>
                    <button
                        onClick={() => window.location.href = '/'}
                        className="group bg-gradient-to-r from-blue-500 to-purple-500 text-white px-12 py-4 rounded-lg font-semibold text-lg hover:from-blue-600 hover:to-purple-600 transition-all duration-300 transform hover:scale-105 shadow-lg hover:shadow-2xl inline-flex items-center gap-2"
                    >
                        <span>Start Chatting Now</span>
                        <span className="group-hover:translate-x-1 transition-transform duration-300">→</span>
                    </button>
                </div>
            </div >
        </div >
    );
};

export default AboutUs;
